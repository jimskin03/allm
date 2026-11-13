import { type MCPToolResult } from './types';

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
/** Decoded size is about three quarters of the base64 length. Keep tool images inside a phone-sized budget. */
const MAX_BASE64_CHARS = 8_000_000;

/**
 * Writes image tool results to app storage and replaces the base64 with a file path.
 * The model receives the path, not the image bytes.
 */
export async function materializeToolResult(result: MCPToolResult): Promise<MCPToolResult> {
  if (!result.content?.some(item => item.type === 'image' && item.data)) return result;
  const content: NonNullable<MCPToolResult['content']> = [];
  for (const item of result.content) {
    if (item.type !== 'image' || typeof item.data !== 'string') {
      content.push(item);
      continue;
    }
    const data = item.data.replace(/\s/g, '');
    const extension = IMAGE_EXTENSIONS[item.mimeType ?? ''] ?? 'png';
    if (!data || data.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      content.push({ type: 'text', text: `[MCP image content${item.mimeType ? `: ${item.mimeType}` : ''}]` });
      continue;
    }
    try {
      const RNFS = require('@dr.pogodin/react-native-fs') as typeof import('@dr.pogodin/react-native-fs');
      const directory = `${RNFS.DocumentDirectoryPath}/mcp-images`;
      await RNFS.mkdir(directory);
      const path = `${directory}/${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
      await RNFS.writeFile(path, data, 'base64');
      content.push({ type: 'text', text: `Image saved on this device: ${path}` });
    } catch {
      content.push({ type: 'text', text: `[MCP image content${item.mimeType ? `: ${item.mimeType}` : ''}]` });
    }
  }
  return { ...result, content };
}
