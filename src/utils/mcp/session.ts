import { isAbortError } from '@/utils/chat/abort';
import { MCPClient } from './client';
import { getServerHeaders, listServers, saveServer } from './config';
import { authorizationNeeded, connectionKey, ensureFreshToken, resolveHeaders, setMcpReconnectHandler } from './oauth';
import { SseMCPClient } from './sseClient';
import { mcpStatus } from './status';
import { MCP_RECONNECT_ATTEMPTS, serverTransport, type MCPServer, type MCPTool, type MCPToolResult } from './types';

type LiveClient = MCPClient | SseMCPClient;

type LiveSession = {
  key: string;
  client: LiveClient;
};

type Retry = { attempt: number; timer?: ReturnType<typeof setTimeout> };

function toolSignature(tools: MCPTool[]): string {
  return JSON.stringify(tools.map(tool => ({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    enabled: tool.enabled !== false,
    inputSchema: tool.inputSchema,
  })));
}

/** New tools start enabled. A tool the user switched off stays off when the server list is refreshed. */
export function mergeTools(stored: MCPTool[], remote: MCPTool[]): MCPTool[] {
  const enabled = new Map(stored.map(tool => [tool.name, tool.enabled !== false]));
  return remote.map(tool => ({ ...tool, enabled: enabled.has(tool.name) ? enabled.get(tool.name) : true }));
}

export function reconnectDelayMs(attempt: number): number {
  const exponential = 1000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 10);
  return Math.min(exponential, 30_000);
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('Could not reach') || message.includes('timed out') || message.includes('SSE stream');
}

class MCPSessionStore {
  private sessions = new Map<string, LiveSession>();
  private retries = new Map<string, Retry>();
  private chains = new Map<string, Promise<unknown>>();

  constructor() {
    setMcpReconnectHandler(server => { this.reconnect(server.id).catch(() => {}); });
  }

  private exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(run);
    this.chains.set(id, job);
    return job;
  }

  private async headersFor(server: MCPServer): Promise<Record<string, string>> {
    const oauth = await ensureFreshToken(server);
    return resolveHeaders(await getServerHeaders(server.id), oauth);
  }

  private open(server: MCPServer, headers: Record<string, string>): LiveClient {
    const transport = serverTransport(server);
    if (transport === 'sse') {
      const client = new SseMCPClient(server.url, headers, 120_000, server.name);
      client.onDisconnect = () => {
        if (this.sessions.get(server.id)?.client === client) this.scheduleReconnect(server.id);
      };
      return client;
    }
    return new MCPClient(server.url, headers, 120_000, server.name);
  }

  private async replace(server: MCPServer, headers: Record<string, string>, force: boolean): Promise<LiveClient> {
    const key = connectionKey(server, headers);
    const existing = this.sessions.get(server.id);
    if (!force && existing && existing.key === key) return existing.client;
    await existing?.client.close().catch(() => {});
    const status = mcpStatus.get(server.id);
    if (status.state !== 'authorizing') mcpStatus.set(server.id, { state: 'connecting' });
    const client = this.open(server, headers);
    this.sessions.set(server.id, { key, client });
    try {
      const remote = await client.listTools();
      const latest = (await listServers()).find(item => item.id === server.id) ?? server;
      const tools = mergeTools(latest.tools, remote);
      if (toolSignature(tools) !== toolSignature(latest.tools)) {
        await saveServer({ ...latest, transport: serverTransport(latest), tools }, await getServerHeaders(server.id));
      }
      this.clearRetry(server.id);
      mcpStatus.set(server.id, { state: 'connected' });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      if (this.sessions.get(server.id)?.client === client) this.sessions.delete(server.id);
      throw error;
    }
  }

  async connect(server: MCPServer, force = false): Promise<void> {
    await this.exclusive(server.id, async () => {
      const headers = await this.headersFor(server);
      try {
        await this.replace(server, headers, force);
      } catch (error) {
        if (await authorizationNeeded(server, await getServerHeaders(server.id), error)) mcpStatus.set(server.id, { state: 'needs_authorization' });
        else mcpStatus.set(server.id, { state: 'error', message: error instanceof Error ? error.message : 'MCP connection failed.' });
        throw error;
      }
    });
  }

  async call(server: MCPServer, headers: Record<string, string>, name: string, args: Record<string, any>, signal?: AbortSignal | null): Promise<MCPToolResult> {
    const client = await this.exclusive(server.id, async () => {
      const existing = this.sessions.get(server.id);
      const key = connectionKey(server, headers);
      if (existing && existing.key === key) return existing.client;
      return this.replace(server, headers, true);
    });
    try {
      return await client.callTool(name, args, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (await authorizationNeeded(server, headers, error)) mcpStatus.set(server.id, { state: 'needs_authorization' });
      else if (isNetworkError(error)) this.scheduleReconnect(server.id);
      throw error;
    }
  }

  async sync(server: MCPServer): Promise<void> {
    await this.connect(server, true);
  }

  private clearRetry(id: string): void {
    const retry = this.retries.get(id);
    if (retry?.timer) clearTimeout(retry.timer);
    this.retries.delete(id);
  }

  private scheduleReconnect(id: string): void {
    const current = this.retries.get(id) ?? { attempt: 0 };
    if (current.timer) return;
    if (current.attempt >= MCP_RECONNECT_ATTEMPTS) {
      mcpStatus.set(id, { state: 'error', message: 'Connection disconnected, maximum reconnect attempts reached' });
      return;
    }
    const attempt = current.attempt + 1;
    mcpStatus.set(id, { state: 'reconnecting', attempt, max: MCP_RECONNECT_ATTEMPTS });
    const timer = setTimeout(() => { this.reconnect(id).catch(() => {}); }, reconnectDelayMs(attempt));
    this.retries.set(id, { attempt, timer });
  }

  private async reconnect(id: string): Promise<void> {
    const current = this.retries.get(id);
    if (current?.timer) clearTimeout(current.timer);
    if (current) this.retries.set(id, { attempt: current.attempt });
    const server = (await listServers()).find(item => item.id === id && item.enabled && item.name.trim());
    if (!server) {
      await this.forget(id);
      return;
    }
    try {
      await this.connect(server, true);
    } catch {
      this.scheduleReconnect(id);
    }
  }

  async forget(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    this.clearRetry(id);
    mcpStatus.remove(id);
    await session?.client.close().catch(() => {});
  }

  async reset(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.forget(id)));
    mcpStatus.reset();
  }
}

export const mcpSessions = new MCPSessionStore();
