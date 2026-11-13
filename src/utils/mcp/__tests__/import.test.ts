jest.mock('@/store/UIStore', () => ({
  __esModule: true,
  default: { getFromStorage: jest.fn(async (_key, fallback) => fallback), setToStorage: jest.fn() },
}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only' },
  getGenericPassword: jest.fn(async () => false),
  setGenericPassword: jest.fn(async () => ({})),
  resetGenericPassword: jest.fn(async () => true),
}));

import { parseMcpImport } from '../importConfig';
import { mergeTools, reconnectDelayMs } from '../session';

test('imports HTTP servers and skips blank, duplicate, and command-only entries', () => {
  const servers = parseMcpImport(JSON.stringify({
    mcpServers: [
      { name: '', url: 'https://example.com/skip' },
      { name: 'docs', url: 'https://example.com/mcp', transport: 'sse', headers: { Authorization: 'Bearer secret' } },
      { name: 'docs', url: 'https://example.com/other' },
      { name: 'local', command: 'npx', args: ['server'] },
      { name: 'http', type: 'http', url: 'http://192.168.1.20/mcp' },
    ],
  }));
  expect(servers.map(server => server.name)).toEqual(['docs', 'http']);
  expect(servers[0]).toMatchObject({ transport: 'sse', headers: { authorization: 'Bearer secret' }, url: 'https://example.com/mcp' });
  expect(servers[1].transport).toBe('streamable_http');
});

test('rejects an import that has no HTTP servers', () => {
  expect(() => parseMcpImport('{"mcpServers":{"local":{"command":"npx"}}}')).toThrow('HTTP bridge');
});

test('keeps a switched-off tool switched off when the server list is refreshed', () => {
  const merged = mergeTools(
    [{ name: 'keep-off', enabled: false, inputSchema: { type: 'object' } }, { name: 'gone', inputSchema: { type: 'object' } }],
    [{ name: 'keep-off', description: 'updated', inputSchema: { type: 'object' } }, { name: 'fresh', inputSchema: { type: 'object' } }],
  );
  expect(merged).toEqual([
    { name: 'keep-off', description: 'updated', inputSchema: { type: 'object' }, enabled: false },
    { name: 'fresh', inputSchema: { type: 'object' }, enabled: true },
  ]);
});

test('backs off reconnect attempts up to 30 seconds', () => {
  expect(reconnectDelayMs(1)).toBe(1000);
  expect(reconnectDelayMs(2)).toBe(2000);
  expect(reconnectDelayMs(6)).toBe(30_000);
});
