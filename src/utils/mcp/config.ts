import * as Keychain from 'react-native-keychain';
import uiStore from '@/store/UIStore';
import { type MCPServer } from './types';
import { toolPrefix } from './toolNames';

const serviceFor = (id: string) => `com.anythingllm.mcp.${id}`;
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'host', 'content-length']);

export function validateServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS MCP endpoint URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials or a fragment.');
  }
  return url.toString();
}

export function parseHeaders(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim() || '{}');
  } catch {
    throw new Error('Headers must be a JSON object with string values.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Headers must be a JSON object with string values.');
  }
  const headers: Record<string, string> = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof entry !== 'string' || /[\r\n]/.test(entry)) {
      throw new Error('Header names and values must be valid HTTP strings.');
    }
    const key = name.toLowerCase();
    if (RESERVED_HEADERS.has(key)) throw new Error(`The ${name} header is managed by the MCP client.`);
    headers[key] = entry;
  }
  return headers;
}

export async function listServers(): Promise<MCPServer[]> {
  return uiStore.getFromStorage<MCPServer[]>('mcp_servers', []);
}

export async function getServerHeaders(id: string): Promise<Record<string, string>> {
  const credentials = await Keychain.getGenericPassword({ service: serviceFor(id) });
  return credentials ? parseHeaders(credentials.password) : {};
}

export async function saveServer(server: MCPServer, headers: Record<string, string>): Promise<void> {
  if (!server.name.trim()) throw new Error('Enter a name for this MCP server.');
  const normalized = { ...server, name: server.name.trim(), url: validateServerUrl(server.url) };
  const checkedHeaders = parseHeaders(JSON.stringify(headers));
  const servers = await listServers();
  const previousHeaders = await getServerHeaders(server.id);
  const previous = servers.find(item => item.id === server.id);
  // An edited endpoint must not inherit the previous server's Always approve choices.
  if (previous && (previous.url !== normalized.url || JSON.stringify(previousHeaders) !== JSON.stringify(checkedHeaders))) {
    await removeToolPreferences(server.id);
  }
  // Save credentials first: a keychain failure must not publish an unusable connection.
  const saved = await Keychain.setGenericPassword('mcp', JSON.stringify(checkedHeaders), {
    service: serviceFor(server.id),
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
  if (!saved) throw new Error('Could not save MCP authentication in secure storage.');
  try {
    const index = servers.findIndex(item => item.id === server.id);
    if (index < 0) servers.push(normalized);
    else servers[index] = normalized;
    await uiStore.setToStorage('mcp_servers', servers);
  } catch (error) {
    await Keychain.setGenericPassword('mcp', JSON.stringify(previousHeaders), { service: serviceFor(server.id) });
    throw error;
  }
}

export async function removeServer(id: string): Promise<void> {
  const servers = await listServers();
  await removeToolPreferences(id);
  await Keychain.resetGenericPassword({ service: serviceFor(id) });
  await uiStore.setToStorage('mcp_servers', servers.filter(server => server.id !== id));
}

async function removeToolPreferences(id: string): Promise<void> {
  for (const key of ['tool_auto_approvals', 'tools'] as const) {
    const values = await uiStore.getFromStorage<Record<string, any>>(key, {});
    const retained = Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith(toolPrefix(id))));
    await uiStore.setToStorage(key, retained);
  }
}

export async function clearServers(): Promise<void> {
  for (const server of await listServers()) {
    await Keychain.resetGenericPassword({ service: serviceFor(server.id) });
  }
  await uiStore.setToStorage('mcp_servers', []);
}
