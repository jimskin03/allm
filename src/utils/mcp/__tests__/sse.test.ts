import { SseMCPClient } from '../sseClient';

type Request = { method: string; url: string; body: any };
const requests: Request[] = [];

class MockXHR {
  status = 200;
  responseText = '';
  responseHeaders: Record<string, string> = {};
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = '';
  url = '';
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader() {}
  getResponseHeader(name: string) { return this.responseHeaders[name.toLowerCase()] ?? null; }
  abort() { this.onabort?.(); }
  send(body: string | null) {
    const request = { method: this.method, url: this.url, body: body ? JSON.parse(body) : null };
    requests.push(request);
    if (methodIsGet(this)) {
      this.chunk('event: endpoint\ndata: /messages?session=1\n\n');
      return;
    }
    this.responseHeaders['content-type'] = 'application/json';
    if (request.body.method === 'notifications/initialized') {
      this.status = 202;
      this.onload?.();
      return;
    }
    const result = request.body.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
      : request.body.method === 'tools/list'
        ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
    this.responseText = JSON.stringify({ jsonrpc: '2.0', id: request.body.id, result });
    this.onload?.();
  }
  chunk(text: string) { this.responseText += text; this.onprogress?.(); }
}

function methodIsGet(xhr: MockXHR): boolean { return xhr.method === 'GET'; }

beforeEach(() => {
  requests.length = 0;
  global.XMLHttpRequest = MockXHR as any;
});

test('reads the legacy SSE endpoint and posts JSON-RPC there', async () => {
  const client = new SseMCPClient('https://example.com/sse', { authorization: 'Bearer secret' });
  expect((await client.listTools()).map(tool => tool.name)).toEqual(['echo']);
  expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://example.com/sse' });
  expect(requests[1]).toMatchObject({ method: 'POST', url: 'https://example.com/messages?session=1' });
  expect(requests.map(request => request.body?.method)).toEqual([undefined, 'initialize', 'notifications/initialized', 'tools/list']);
  expect(await client.callTool('echo', {})).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  await client.close();
});
