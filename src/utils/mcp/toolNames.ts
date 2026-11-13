/* eslint-disable no-bitwise */
/** Stable, provider-safe names (53 characters), including the entire server UUID. */
export const toolPrefix = (serverId: string) => `mcp_${serverId.replace(/-/g, '')}_`;

export function toolNameFor(serverId: string, name: string): string {
  // Two independently seeded 32-bit hashes keep long/unicode MCP names inside provider limits.
  const hash = (seed: number) => {
    let value = seed;
    for (let i = 0; i < name.length; i++) value = Math.imul(value ^ name.charCodeAt(i), 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  return `${toolPrefix(serverId)}${hash(2166136261)}${hash(5381)}`;
}
