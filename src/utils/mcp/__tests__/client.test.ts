import { MCPClient } from '../client';

type Request = { method: string; headers: Record<string, string>; body: any };
let handleRequest: (xhr: MockXHR, request: Request) => void;
const requests: Request[] = [];
const instances: MockXHR[] = [];

/** Simulates native XHR's cumulative responseText and progress events, including open SSE bodies. */
class MockXHR {
  status = 200;
  responseText = '';
  responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = '';
  headers: Record<string, string> = {};
  aborted = false;

  constructor() { instances.push(this); }
  open(method: string) { this.method = method; }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; }
  getResponseHeader(name: string) { return this.responseHeaders[name.toLowerCase()] ?? null; }
  abort() { this.aborted = true; this.onabort?.(); }
  send(body: string | null) {
    const request = { method: this.method, headers: this.headers, body: body ? JSON.parse(body) : null };
    requests.push(request);
    handleRequest(this, request);
  }
  respond(result: any, id?: number) {
    this.responseText = JSON.stringify({ jsonrpc: '2.0', id: id ?? requests[requests.length - 1].body.id, result });
    this.onload?.();
  }
  chunk(text: string) { this.responseText += text; this.onprogress?.(); }
}

const weatherTool = { name: 'weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const defaultHandler = (xhr: MockXHR, { method, body }: Request) => {
  if (method === 'DELETE' || body.method === 'notifications/initialized') {
    xhr.status = 202;
    xhr.onload?.();
  } else if (body.method === 'initialize') {
    xhr.responseHeaders['mcp-session-id'] = 'session-one';
    xhr.respond({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
  } else if (body.method === 'tools/list') xhr.respond({ tools: [weatherTool] });
  else if (body.method === 'tools/call') xhr.respond({ content: [{ type: 'text', text: 'Sunny' }] });
};

beforeEach(() => {
  requests.length = instances.length = 0;
  handleRequest = defaultHandler;
  global.XMLHttpRequest = MockXHR as any;
});

afterEach(() => { jest.useRealTimers(); });

test('negotiates the protocol, sends initialized, lists tools and keeps auth/session headers', async () => {
  const client = new MCPClient('https://example.com/mcp', { authorization: 'Bearer secret' });
  expect(await client.listTools()).toEqual([weatherTool]);
  expect(requests.map(request => request.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  expect(requests[0].body.params.capabilities).toEqual({});
  expect(requests[0].headers.accept).toBe('application/json, text/event-stream');
  expect(requests[0].headers['mcp-session-id']).toBeUndefined();
  for (const request of requests.slice(1)) {
    expect(request.headers['mcp-session-id']).toBe('session-one');
    expect(request.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(request.headers.authorization).toBe('Bearer secret');
  }
  const result = await client.callTool('weather', { city: 'Paris' });
  expect(result.content?.[0].text).toBe('Sunny');
  expect(requests[3].body.params).toEqual({ name: 'weather', arguments: { city: 'Paris' } });
  await client.close();
  expect(requests[4]).toMatchObject({ method: 'DELETE', headers: { 'mcp-session-id': 'session-one' } });
});

test('handles stateless servers and paginated tool discovery', async () => {
  handleRequest = (xhr, request) => {
    if (request.body.method === 'initialize') xhr.respond({ protocolVersion: '2025-03-26', capabilities: { tools: {} } });
    else if (request.body.method === 'tools/list') {
      xhr.respond(request.body.params.cursor ? { tools: [{ ...weatherTool, name: 'time' }] } : { tools: [weatherTool], nextCursor: 'page-two' });
    } else defaultHandler(xhr, request);
  };
  const client = new MCPClient('https://example.com/mcp');
  expect((await client.listTools()).map(tool => tool.name)).toEqual(['weather', 'time']);
  expect(requests[3].body.params).toEqual({ cursor: 'page-two' });
  await client.close();
  expect(requests).toHaveLength(4);
});

test('reads split SSE frames and multiline data without waiting for the server to close', async () => {
  handleRequest = (xhr, request) => {
    if (request.body.method !== 'tools/call') return defaultHandler(xhr, request);
    xhr.responseHeaders['content-type'] = 'text/event-stream; charset=utf-8';
    const frame = `: keepalive\r\n\r\ndata:\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":${request.body.id},"result":{"content":[{"type":"text","text":"streamed ✓"}]}}\r\n\r\n`;
    for (const character of frame) xhr.chunk(character);
    // Deliberately no onload: many servers keep the SSE connection open.
  };
  const client = new MCPClient('https://example.com/mcp');
  expect(await client.callTool('weather', {})).toEqual({ content: [{ type: 'text', text: 'streamed ✓' }] });
  expect(instances[2].aborted).toBe(true);
  await client.close();
});

test('supports SSE initialize results as well as JSON responses', async () => {
  handleRequest = (xhr, request) => {
    if (request.body?.method !== 'initialize') return defaultHandler(xhr, request);
    xhr.responseHeaders = { 'content-type': 'text/event-stream', 'mcp-session-id': 'stream-session' };
    xhr.chunk(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } })}\n\n`);
  };
  const client = new MCPClient('https://example.com/mcp');
  expect(await client.listTools()).toEqual([weatherTool]);
  expect(requests[2].headers['mcp-session-id']).toBe('stream-session');
  await client.close();
});

test('answers server pings and rejects unsupported server requests during SSE', async () => {
  handleRequest = (xhr, request) => {
    if (!request.body?.method) { xhr.status = 202; xhr.onload?.(); return; }
    if (request.body.method !== 'tools/call') return defaultHandler(xhr, request);
    xhr.responseHeaders['content-type'] = 'text/event-stream';
    xhr.chunk('data: {"jsonrpc":"2.0","id":"ping-1","method":"ping"}\n\n');
    xhr.chunk('data: {"jsonrpc":"2.0","id":"sampling-1","method":"sampling/createMessage"}\n\n');
    xhr.chunk(`data: {"jsonrpc":"2.0","id":${request.body.id},"result":{"content":[]}}\n\n`);
  };
  const client = new MCPClient('https://example.com/mcp');
  await client.callTool('weather', {});
  expect(requests.find(request => request.body?.id === 'ping-1')?.body.result).toEqual({});
  expect(requests.find(request => request.body?.id === 'sampling-1')?.body.error.code).toBe(-32601);
  await client.close();
});

test.each([401, 403, 404, 500])('reports HTTP %s without replaying a tool call', async status => {
  handleRequest = (xhr, request) => {
    if (request.body.method !== 'tools/call') return defaultHandler(xhr, request);
    xhr.status = status;
    xhr.onload?.();
  };
  const client = new MCPClient('https://example.com/mcp');
  await expect(client.callTool('weather', {})).rejects.toThrow(`HTTP ${status}`);
  expect(requests.filter(request => request.body.method === 'tools/call')).toHaveLength(1);
  await client.close();
});

test('surfaces JSON-RPC tool errors', async () => {
  handleRequest = (xhr, request) => {
    if (request.body.method !== 'tools/call') return defaultHandler(xhr, request);
    xhr.responseText = JSON.stringify({ jsonrpc: '2.0', id: request.body.id, error: { code: -32602, message: 'Missing city' } });
    xhr.onload?.();
  };
  const client = new MCPClient('https://example.com/mcp');
  await expect(client.callTool('weather', {})).rejects.toThrow('Missing city');
  await client.close();
});

test('cancels an open request and does not send an already-cancelled request', async () => {
  handleRequest = () => {};
  const client = new MCPClient('https://example.com/mcp');
  const controller = new AbortController();
  const pending = client.listTools(controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(instances[0].aborted).toBe(true);
  await expect(client.listTools(controller.signal)).rejects.toMatchObject({ name: 'ChatAbortedError' });
  expect(requests).toHaveLength(1);
});

test('times out a stalled connection', async () => {
  jest.useFakeTimers();
  handleRequest = () => {};
  const pending = new MCPClient('https://example.com/mcp', {}, 100).listTools();
  jest.advanceTimersByTime(100);
  await expect(pending).rejects.toThrow('timed out');
  expect(instances[0].aborted).toBe(true);
});

test('notifies the server when a running tool is cancelled', async () => {
  const client = new MCPClient('https://example.com/mcp');
  await client.connect();
  handleRequest = (xhr, request) => {
    if (request.body?.method === 'tools/call') return;
    xhr.status = 202;
    xhr.onload?.();
  };
  const controller = new AbortController();
  const pending = client.callTool('weather', {}, controller.signal);
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const call = requests.find(request => request.body?.method === 'tools/call');
  expect(requests.find(request => request.body?.method === 'notifications/cancelled')?.body.params.requestId).toBe(call?.body.id);
  await client.close();
});

test.each([
  { ...weatherTool, description: {} },
  { ...weatherTool, inputSchema: { type: 'object', properties: [] } },
  { ...weatherTool, inputSchema: { type: 'object', required: 'city' } },
])('rejects malformed remote tool definitions', async tool => {
  handleRequest = (xhr, request) => {
    if (request.body.method === 'tools/list') xhr.respond({ tools: [tool] });
    else defaultHandler(xhr, request);
  };
  const client = new MCPClient('https://example.com/mcp');
  await expect(client.listTools()).rejects.toThrow('invalid tool definition');
  await client.close();
});

test('rejects incompatible protocol versions', async () => {
  handleRequest = xhr => xhr.respond({ protocolVersion: '2099-01-01', capabilities: {} });
  await expect(new MCPClient('https://example.com/mcp').listTools()).rejects.toThrow('unsupported protocol version');
});

test('does not list tools when the server lacks the capability', async () => {
  handleRequest = (xhr, request) => {
    if (request.body.method === 'initialize') xhr.respond({ protocolVersion: '2025-06-18', capabilities: {} });
    else defaultHandler(xhr, request);
  };
  expect(await new MCPClient('https://example.com/mcp').listTools()).toEqual([]);
  expect(requests.map(request => request.body.method)).toEqual(['initialize', 'notifications/initialized']);
});

test('rejects repeated pagination cursors instead of looping forever', async () => {
  handleRequest = (xhr, request) => {
    if (request.body.method === 'tools/list') xhr.respond({ tools: [], nextCursor: 'same' });
    else defaultHandler(xhr, request);
  };
  const client = new MCPClient('https://example.com/mcp');
  await expect(client.listTools()).rejects.toThrow('pagination cursor');
  await client.close();
});

test.each(['not json', '{"jsonrpc":"2.0","id":999,"result":{}}'])('rejects invalid/mismatched responses: %s', async text => {
  handleRequest = xhr => { xhr.responseText = text; xhr.onload?.(); };
  await expect(new MCPClient('https://example.com/mcp').listTools()).rejects.toThrow();
});
