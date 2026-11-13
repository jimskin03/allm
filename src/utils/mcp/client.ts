import { linkAbortSignal, throwIfAborted } from '@/utils/chat/abort';
import { type MCPTool, type MCPToolResult } from './types';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

/**
 * Streamable HTTP using native XHR, whose incremental responseText works on Android.
 * React Native's default fetch buffers bodies and cannot consume an open SSE response.
 * Each client owns one short-lived MCP session; tool calls are never retried automatically.
 */
export class MCPClient {
  private sessionId?: string;
  private protocolVersion?: string;
  private nextId = 0;
  private supportsTools = false;

  constructor(private url: string, private headers: Record<string, string> = {}, private timeoutMs = 60_000) {}

  private send(message: Message, signal?: AbortSignal | null, method = 'POST'): Promise<any> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const controller = new AbortController();
      const unlink = linkAbortSignal(controller, signal);
      let settled = false;
      let offset = 0;
      let buffer = '';
      const finish = (error?: Error, result?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unlink();
        controller.signal.removeEventListener('abort', onAbort);
        xhr.onprogress = xhr.onload = xhr.onerror = xhr.onabort = null;
        xhr.abort();
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => {
        const error = new Error('MCP request cancelled.');
        error.name = 'AbortError';
        finish(error);
        if (method === 'POST' && message.id !== undefined && message.method && message.method !== 'initialize') {
          this.cancelRequest(message.id);
        }
      };
      const timer = setTimeout(() => finish(new Error('MCP server request timed out.')), this.timeoutMs);
      controller.signal.addEventListener('abort', onAbort);

      const receive = (reply: Message) => {
        if (reply.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC response.');
        if (reply.method) {
          // We advertise no optional client capabilities. Ping is always supported.
          if (reply.id !== undefined) {
            const answer: Message = reply.method === 'ping'
              ? { jsonrpc: '2.0', id: reply.id, result: {} }
              : { jsonrpc: '2.0', id: reply.id, error: { code: -32601, message: 'Client method not supported' } };
            this.send(answer, signal).catch(() => {});
          }
          return;
        }
        if (reply.id !== message.id) return;
        if (reply.error) finish(new Error(`MCP error ${reply.error.code}: ${reply.error.message}`));
        else if ('result' in reply) finish(undefined, reply.result);
        else throw new Error('MCP response has no result.');
      };
      const readHeaders = () => {
        if (message.method === 'initialize') {
          this.sessionId = xhr.getResponseHeader('MCP-Session-Id') || undefined;
        }
      };
      const readStream = () => {
        if (settled || xhr.status < 200 || xhr.status >= 300) return;
        readHeaders();
        if (!xhr.getResponseHeader('Content-Type')?.toLowerCase().includes('text/event-stream')) return;
        buffer += xhr.responseText.slice(offset);
        offset = xhr.responseText.length;
        let separator: RegExpExecArray | null;
        while (!settled && (separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = frame.split(/\r\n|\n|\r/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data.trim()) receive(JSON.parse(data));
        }
      };
      xhr.onprogress = () => {
        try { readStream(); } catch { finish(new Error('Invalid MCP event stream.')); }
      };
      xhr.onload = () => {
        try {
          if (xhr.status < 200 || xhr.status >= 300) {
            if (xhr.status === 404 && this.sessionId) {
              this.sessionId = this.protocolVersion = undefined;
            }
            finish(new Error(`MCP server returned HTTP ${xhr.status}. Check the endpoint and authentication headers.`));
            return;
          }
          readHeaders();
          if (!message.method || message.id === undefined || method === 'DELETE') {
            finish();
          } else if (xhr.getResponseHeader('Content-Type')?.toLowerCase().includes('text/event-stream')) {
            readStream();
            if (!settled) finish(new Error('MCP stream ended before the server returned a result.'));
          } else {
            receive(JSON.parse(xhr.responseText));
            if (!settled) finish(new Error('MCP server returned a response for a different request.'));
          }
        } catch {
          finish(new Error('Invalid MCP server response.'));
        }
      };
      xhr.onerror = () => finish(new Error('Could not reach the MCP server.'));
      xhr.onabort = onAbort;
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      try {
        xhr.open(method, this.url, true);
        for (const [name, value] of Object.entries(this.headers)) xhr.setRequestHeader(name, value);
        xhr.setRequestHeader('Accept', 'application/json, text/event-stream');
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (this.sessionId) xhr.setRequestHeader('MCP-Session-Id', this.sessionId);
        if (this.protocolVersion) xhr.setRequestHeader('MCP-Protocol-Version', this.protocolVersion);
        xhr.send(method === 'DELETE' ? null : JSON.stringify(message));
      } catch {
        finish(new Error('Could not send the MCP request.'));
      }
    });
  }

  private request(method: string, params: any, signal?: AbortSignal | null): Promise<any> {
    return this.send({ jsonrpc: '2.0', id: ++this.nextId, method, params }, signal);
  }

  private cancelRequest(requestId: number | string): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'Cancelled by user' } }, controller.signal)
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }

  async connect(signal?: AbortSignal | null): Promise<void> {
    if (this.protocolVersion) return;
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: 'anythingllm-mobile', version: '1.0.0' },
    }, signal);
    if (!PROTOCOL_VERSIONS.includes(result?.protocolVersion)) throw new Error('The MCP server selected an unsupported protocol version.');
    this.protocolVersion = result.protocolVersion;
    this.supportsTools = !!result.capabilities?.tools;
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
  }

  async listTools(signal?: AbortSignal | null): Promise<MCPTool[]> {
    await this.connect(signal);
    if (!this.supportsTools) return [];
    const tools: MCPTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {}, signal);
      if (!Array.isArray(page?.tools)) throw new Error('MCP server returned an invalid tool list.');
      for (const tool of page.tools) {
        const schema = tool?.inputSchema;
        if (typeof tool?.name !== 'string' || !tool.name || schema?.type !== 'object'
          || (tool.title !== undefined && typeof tool.title !== 'string')
          || (tool.description !== undefined && typeof tool.description !== 'string')
          || (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)))
          || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string')))) {
          throw new Error('MCP server returned an invalid tool definition.');
        }
        if (tools.some(existing => existing.name === tool.name)) throw new Error('MCP server returned duplicate tool names.');
        tools.push(tool);
      }
      cursor = page.nextCursor;
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
    if (this.sessionId) {
      // Cleanup is best effort and bounded independently of a long-running tool request.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try { await this.send({ jsonrpc: '2.0' }, controller.signal, 'DELETE'); } catch {}
      finally { clearTimeout(timer); }
    }
    this.sessionId = this.protocolVersion = undefined;
  }
}
