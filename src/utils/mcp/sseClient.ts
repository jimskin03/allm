import { linkAbortSignal, throwIfAborted } from '@/utils/chat/abort';
import { PROTOCOL_VERSIONS, readToolPage } from './client';
import { type MCPTool, type MCPToolResult } from './types';

type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Legacy MCP HTTP+SSE: a long-lived GET carries server events, and JSON-RPC is POSTed
 * to the endpoint URL from the first `endpoint` event. Results arrive on the GET stream.
 */
export class SseMCPClient {
  private endpoint?: string;
  private protocolVersion?: string;
  private supportsTools = false;
  private nextId = 0;
  private closed = false;
  private xhr?: XMLHttpRequest;
  private buffer = '';
  private offset = 0;
  private pending = new Map<number | string, Pending>();
  /** Fired when the event stream drops after a successful connect. Not fired for close(). */
  onDisconnect?: (error: Error) => void;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
    private timeoutMs = 120_000,
    private clientName = 'anythingllm-mobile',
  ) {}

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private deliver(reply: Message): void {
    if (reply.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC response.');
    if (reply.method) {
      if (reply.id !== undefined) {
        const answer: Message = reply.method === 'ping'
          ? { jsonrpc: '2.0', id: reply.id, result: {} }
          : { jsonrpc: '2.0', id: reply.id, error: { code: -32601, message: 'Client method not supported' } };
        this.post(answer).catch(() => {});
      }
      return;
    }
    if (reply.id === undefined) return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(`MCP error ${reply.error.code}: ${reply.error.message}`));
    else if ('result' in reply) pending.resolve(reply.result);
    else pending.reject(new Error('MCP response has no result.'));
  }

  private readFrames(xhr: XMLHttpRequest): void {
    this.buffer += xhr.responseText.slice(this.offset);
    this.offset = xhr.responseText.length;
    let separator: RegExpExecArray | null;
    while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      let event = 'message';
      const data = frame.split(/\r\n|\n|\r/).flatMap(line => {
        if (!line || line.startsWith(':')) return [];
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          return [];
        }
        if (line.startsWith('data:')) return [line.slice(5).replace(/^ /, '')];
        return [];
      }).join('\n');
      if (!data.trim()) continue;
      if (event === 'endpoint' && !this.endpoint) {
        const resolved = new URL(data.trim(), this.url);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') throw new Error('MCP SSE endpoint must be an HTTP URL.');
        this.endpoint = resolved.toString();
        continue;
      }
      this.deliver(JSON.parse(data));
    }
  }

  private openStream(signal?: AbortSignal | null): Promise<void> {
    throwIfAborted(signal);
    if (this.endpoint) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const controller = new AbortController();
      const unlink = linkAbortSignal(controller, signal);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unlink();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('MCP server request timed out.')), 20_000);
      xhr.onprogress = () => {
        try {
          this.readFrames(xhr);
          if (this.endpoint) finish();
        } catch {
          finish(new Error('Invalid MCP event stream.'));
        }
      };
      xhr.onload = () => {
        try { this.readFrames(xhr); } catch { /* stream parse errors are reported below */ }
        if (!this.endpoint) finish(new Error('MCP SSE stream ended before an endpoint event.'));
        else if (!this.closed) this.onDisconnect?.(new Error('MCP SSE stream closed.'));
      };
      xhr.onerror = () => {
        const error = new Error('Could not reach the MCP server.');
        if (!this.endpoint) finish(error);
        else if (!this.closed) this.onDisconnect?.(error);
      };
      xhr.onabort = () => {
        if (!this.closed && this.endpoint) this.onDisconnect?.(new Error('MCP SSE stream closed.'));
      };
      controller.signal.addEventListener('abort', () => {
        const error = new Error('MCP request cancelled.');
        error.name = 'AbortError';
        xhr.abort();
        finish(error);
      });
      this.xhr = xhr;
      try {
        xhr.open('GET', this.url, true);
        for (const [name, value] of Object.entries(this.headers)) xhr.setRequestHeader(name, value);
        xhr.setRequestHeader('Accept', 'text/event-stream');
        xhr.send();
      } catch {
        finish(new Error('Could not send the MCP request.'));
      }
    });
  }

  private post(message: Message, signal?: AbortSignal | null): Promise<void> {
    throwIfAborted(signal);
    if (!this.endpoint) return Promise.reject(new Error('MCP SSE endpoint is not ready.'));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const controller = new AbortController();
      const unlink = linkAbortSignal(controller, signal);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unlink();
        xhr.abort();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('MCP server request timed out.')), this.timeoutMs);
      controller.signal.addEventListener('abort', () => {
        const error = new Error('MCP request cancelled.');
        error.name = 'AbortError';
        finish(error);
      });
      xhr.onload = () => {
        try {
          if (xhr.status < 200 || xhr.status >= 300) {
            finish(new Error(`MCP server returned HTTP ${xhr.status}. Check the endpoint and authentication headers.`));
            return;
          }
          const type = xhr.getResponseHeader('Content-Type')?.toLowerCase() ?? '';
          if (type.includes('application/json') && xhr.responseText.trim()) this.deliver(JSON.parse(xhr.responseText));
          finish();
        } catch {
          finish(new Error('Invalid MCP server response.'));
        }
      };
      xhr.onerror = () => finish(new Error('Could not reach the MCP server.'));
      try {
        xhr.open('POST', this.endpoint!, true);
        for (const [name, value] of Object.entries(this.headers)) xhr.setRequestHeader(name, value);
        xhr.setRequestHeader('Accept', 'application/json, text/event-stream');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify(message));
      } catch {
        finish(new Error('Could not send the MCP request.'));
      }
    });
  }

  private request(method: string, params: any, signal?: AbortSignal | null): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP server request timed out.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ jsonrpc: '2.0', id, method, params }, signal).catch(error => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async connect(signal?: AbortSignal | null): Promise<void> {
    if (this.protocolVersion) return;
    await this.openStream(signal);
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: this.clientName, version: '1.0.0' },
    }, signal);
    if (!PROTOCOL_VERSIONS.includes(result?.protocolVersion)) throw new Error('The MCP server selected an unsupported protocol version.');
    this.protocolVersion = result.protocolVersion;
    this.supportsTools = !!result.capabilities?.tools;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
  }

  async listTools(signal?: AbortSignal | null): Promise<MCPTool[]> {
    await this.connect(signal);
    if (!this.supportsTools) return [];
    const tools: MCPTool[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = readToolPage(await this.request('tools/list', cursor ? { cursor } : {}, signal), seen);
      tools.push(...page.tools);
      cursor = page.cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('MCP server returned an invalid pagination cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, any>, signal?: AbortSignal | null): Promise<MCPToolResult> {
    await this.connect(signal);
    if (!this.supportsTools) throw new Error('This MCP server does not provide tools.');
    return this.request('tools/call', { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.xhr?.abort();
    this.fail(new Error('MCP request cancelled.'));
    this.endpoint = this.protocolVersion = undefined;
    this.xhr = undefined;
  }
}
