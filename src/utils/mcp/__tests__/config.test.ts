const mockStorage: Record<string, any> = {};
const mockKeychain = new Map<string, string>();
let mockKeychainFails = false;
let mockMetadataFails = false;
jest.mock('@/store/UIStore', () => ({
  __esModule: true,
  default: {
    getFromStorage: jest.fn(async (key, fallback) => JSON.parse(JSON.stringify(mockStorage[key] ?? fallback))),
    setToStorage: jest.fn(async (key, value) => {
      if (mockMetadataFails && key === 'mcp_servers') throw new Error('disk full');
      mockStorage[key] = JSON.parse(JSON.stringify(value));
    }),
  },
}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only' },
  getGenericPassword: jest.fn(async ({ service }) => mockKeychain.has(service) ? { password: mockKeychain.get(service) } : false),
  setGenericPassword: jest.fn(async (_username, password, { service }) => {
    if (mockKeychainFails) return false;
    mockKeychain.set(service, password);
    return { service };
  }),
  resetGenericPassword: jest.fn(async ({ service }) => mockKeychain.delete(service)),
}));

import { clearServers, getServerHeaders, listServers, parseHeaders, removeServer, saveServer, validateServerUrl } from '../config';
import { toolNameFor } from '../toolNames';
import { type MCPServer } from '../types';

const server: MCPServer = { id: '12345678-abcd-1234-abcd-123456789012', name: 'Test', url: 'https://example.com/mcp', enabled: true, tools: [] };

beforeEach(() => {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  mockKeychain.clear();
  mockKeychainFails = false;
  mockMetadataFails = false;
});

test.each(['file:///tmp/mcp', 'ws://example.com', 'not a url', 'https://user:password@example.com/mcp', 'https://example.com/mcp#fragment'])('rejects invalid or credential-bearing URL %s', url => {
  expect(() => validateServerUrl(url)).toThrow();
});

test('accepts LAN endpoints and normalizes HTTP headers', () => {
  expect(validateServerUrl(' http://192.168.1.10:8080/mcp ')).toBe('http://192.168.1.10:8080/mcp');
  expect(parseHeaders('{"Authorization":"Bearer secret","X-Api-Key":"key"}')).toEqual({ authorization: 'Bearer secret', 'x-api-key': 'key' });
});

test.each(['[]', 'null', '{"key":10}', '{"key":"bad\\r\\nheader"}', '{"bad name":"x"}', '{"MCP-Session-Id":"x"}', '{"Accept":"x"}'])('rejects invalid or protocol-overriding headers %s', headers => {
  expect(() => parseHeaders(headers)).toThrow();
});

test('stores credentials only in the keychain and restores configuration after reload', async () => {
  await saveServer(server, { Authorization: 'Bearer secret' });
  expect(JSON.stringify(mockStorage)).not.toContain('Bearer secret');
  expect(await listServers()).toEqual([server]);
  expect(await getServerHeaders(server.id)).toEqual({ authorization: 'Bearer secret' });
});

test('does not publish a connection when secure storage fails', async () => {
  mockKeychainFails = true;
  await expect(saveServer(server, { authorization: 'secret' })).rejects.toThrow('secure storage');
  expect(await listServers()).toEqual([]);
});

test('rolls back authentication when metadata persistence fails', async () => {
  await saveServer(server, { authorization: 'original' });
  mockMetadataFails = true;
  await expect(saveServer(server, { authorization: 'replacement' })).rejects.toThrow('disk full');
  expect(await getServerHeaders(server.id)).toEqual({ authorization: 'original' });
});

test('endpoint edits revoke existing tool approvals and toggles', async () => {
  await saveServer(server, {});
  const toolName = toolNameFor(server.id, 'weather');
  mockStorage.tool_auto_approvals = { [toolName]: { approvedAt: 1 }, builtInTool: { approvedAt: 1 } };
  mockStorage.tools = { [toolName]: true, builtInTool: true };
  await saveServer({ ...server, url: 'https://other.example.com/mcp' }, {});
  expect(mockStorage.tool_auto_approvals).toEqual({ builtInTool: { approvedAt: 1 } });
  expect(mockStorage.tools).toEqual({ builtInTool: true });
});

test('removal and app reset erase credentials and saved connections', async () => {
  await saveServer(server, { authorization: 'secret' });
  await saveServer({ ...server, id: 'other' }, { authorization: 'other-secret' });
  await removeServer(server.id);
  expect(await getServerHeaders(server.id)).toEqual({});
  expect((await listServers()).map(item => item.id)).toEqual(['other']);
  await clearServers();
  expect(mockKeychain.size).toBe(0);
  expect(await listServers()).toEqual([]);
});
