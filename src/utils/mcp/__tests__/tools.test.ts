jest.mock('../config', () => ({ listServers: jest.fn(), getServerHeaders: jest.fn() }));
jest.mock('../client', () => ({ MCPClient: jest.fn() }));
jest.mock('@/utils/ToolsManager/toolApproval', () => ({ __esModule: true, default: { request: jest.fn() } }));
jest.mock('@/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }));

import MCPManager, { discoverTools, formatToolResult } from '../index';
import { listServers, getServerHeaders } from '../config';
import { MCPClient } from '../client';
import ToolApproval from '@/utils/ToolsManager/toolApproval';
import { toolNameFor } from '../toolNames';
import { type MCPServer, type MCPTool } from '../types';

const schema: MCPTool['inputSchema'] = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
  $defs: { example: { type: 'string' } },
};
const server: MCPServer = {
  id: '12345678-abcd-1234-abcd-123456789012', name: 'Weather', url: 'https://example.com/mcp', enabled: true,
  tools: [{ name: 'weather.forecast', title: 'Forecast', description: 'Get the weather', inputSchema: schema }],
};
const mockClient = { callTool: jest.fn(), listTools: jest.fn(), close: jest.fn() };

beforeEach(async () => {
  jest.clearAllMocks();
  (listServers as jest.Mock).mockResolvedValue([server]);
  (getServerHeaders as jest.Mock).mockResolvedValue({ authorization: 'secret' });
  (ToolApproval.request as jest.Mock).mockResolvedValue({ approved: true });
  (MCPClient as jest.Mock).mockImplementation(() => mockClient);
  mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'Sunny' }] });
  await MCPManager.load();
});

test('adapts cached tools with stable names, full JSON schema and per-server identity', () => {
  const [tool] = MCPManager.tools;
  expect(tool.name).toBe('Weather: Forecast');
  expect(tool.definition.function.parameters).toEqual(schema);
  expect(tool.definition.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(tool.hiddenFromScheduledJobs).toBe(true);
  expect(toolNameFor(server.id, 'weather.forecast')).toBe(tool.definition.function.name);
  expect(toolNameFor('22345678-abcd-1234-abcd-123456789012', 'weather.forecast')).not.toBe(tool.definition.function.name);
  expect(toolNameFor(server.id, 'weather-forecast')).not.toBe(tool.definition.function.name);
  expect(toolNameFor(server.id, 'a'.repeat(200))).toHaveLength(53);
});

test('requires approval before sending arguments and returns the remote result', async () => {
  const stream = jest.fn();
  const result = await MCPManager.tools[0].execute('{"city":"Paris"}', stream, {});
  expect(result).toBe('Sunny');
  expect(ToolApproval.request).toHaveBeenCalledWith(expect.objectContaining({ payload: { server: 'Weather', tool: 'weather.forecast', arguments: { city: 'Paris' } }, streamEmitter: stream }));
  expect(mockClient.callTool).toHaveBeenCalledWith('weather.forecast', { city: 'Paris' }, undefined);
  expect(mockClient.close).toHaveBeenCalled();
});

test('rejection does not contact the remote server', async () => {
  (ToolApproval.request as jest.Mock).mockResolvedValue({ approved: false, message: 'User rejected' });
  expect(await MCPManager.tools[0].execute('{}', jest.fn(), {})).toBe('User rejected');
  expect(MCPClient).not.toHaveBeenCalled();
  expect(getServerHeaders).not.toHaveBeenCalled();
});

test('disabled servers are absent and stale tool references cannot execute', async () => {
  const [tool] = MCPManager.tools;
  (listServers as jest.Mock).mockResolvedValue([{ ...server, enabled: false }]);
  await MCPManager.load();
  expect(MCPManager.tools).toEqual([]);
  expect(await tool.execute('{}', jest.fn(), {})).toContain('no longer available');
  expect(ToolApproval.request).not.toHaveBeenCalled();
  expect(MCPClient).not.toHaveBeenCalled();
});

test('rechecks availability after waiting for an approval', async () => {
  (ToolApproval.request as jest.Mock).mockImplementation(async () => {
    (listServers as jest.Mock).mockResolvedValue([]);
    return { approved: true };
  });
  expect(await MCPManager.tools[0].execute('{}', jest.fn(), {})).toContain('no longer available');
  expect(MCPClient).not.toHaveBeenCalled();
});

test.each(['null', '[]', 'invalid json'])('invalid arguments %s never reach the server', async args => {
  expect(await MCPManager.tools[0].execute(args, jest.fn(), {})).toContain('Error:');
  expect(MCPClient).not.toHaveBeenCalled();
});

test('preserves cancellation and closes the session on a failed tool call', async () => {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  mockClient.callTool.mockRejectedValueOnce(error);
  await expect(MCPManager.tools[0].execute('{}', jest.fn(), {})).rejects.toBe(error);
  expect(mockClient.close).toHaveBeenCalled();
});

test('unattended jobs cannot silently approve remote tools', async () => {
  expect(await MCPManager.tools[0].execute('{}', jest.fn(), { autoApproveTools: true })).toContain('unattended');
  expect(ToolApproval.request).not.toHaveBeenCalled();
  expect(MCPClient).not.toHaveBeenCalled();
});

test('formats structured results and embedded resources without binary payloads', () => {
  const result = formatToolResult({
    isError: true,
    content: [
      { type: 'text', text: 'Failed' },
      { type: 'resource', resource: { text: 'Document contents' } },
      { type: 'resource_link', uri: 'https://example.com/file' },
      { type: 'image', mimeType: 'image/png', data: 'DO_NOT_SEND_BASE64' } as any,
    ],
    structuredContent: { status: 'failed' },
  });
  expect(result).toContain('Error: Failed');
  expect(result).toContain('Document contents');
  expect(result).toContain('https://example.com/file');
  expect(result).toContain('{"status":"failed"}');
  expect(result).not.toContain('DO_NOT_SEND_BASE64');
});

test('discovery closes the MCP session even if listing fails', async () => {
  mockClient.listTools.mockRejectedValueOnce(new Error('unavailable'));
  await expect(discoverTools(server.url, {})).rejects.toThrow('unavailable');
  expect(mockClient.close).toHaveBeenCalled();
});
