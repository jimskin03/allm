import { parseHeaders, validateServerUrl } from './config';
import { type MCPTransport } from './types';

export type ImportedMCPServer = {
  name: string;
  url: string;
  transport: MCPTransport;
  headers: Record<string, string>;
};

function transportOf(value: unknown): MCPTransport | null {
  if (value === 'sse') return 'sse';
  if (value === 'http' || value === 'streamable_http' || value === 'streamable-http' || value == null) return 'streamable_http';
  return null;
}

function readEntry(name: string, value: unknown): ImportedMCPServer | null {
  if (!name.trim() || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string' && !record.url && !record.serverUrl && !record.httpUrl) return null;
  const rawUrl = record.url ?? record.serverUrl ?? record.httpUrl;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  const transport = transportOf(record.transport ?? record.type);
  if (!transport) return null;
  const headerSource = record.headers == null ? '{}' : JSON.stringify(record.headers);
  return { name: name.trim(), url: validateServerUrl(rawUrl), transport, headers: parseHeaders(headerSource) };
}

/**
 * Accepts a Friendly, Claude, or Cursor `mcpServers` document.
 * Blank names, duplicate names, and command-only stdio servers are skipped.
 */
export function parseMcpImport(text: string): ImportedMCPServer[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('MCP import must be a JSON object.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP import must be a JSON object.');
  const root = parsed as Record<string, unknown>;
  const source = root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : root;
  const entries: Array<[string, unknown]> = Array.isArray(source)
    ? source.map(item => [String((item as { name?: unknown })?.name ?? ''), item])
    : Object.entries(source as Record<string, unknown>);
  const seen = new Set<string>();
  const servers: ImportedMCPServer[] = [];
  for (const [name, value] of entries) {
    const entry = readEntry(name, value);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    servers.push(entry);
  }
  if (servers.length === 0) throw new Error('No HTTP MCP servers found. Command servers need an HTTP bridge.');
  return servers;
}
