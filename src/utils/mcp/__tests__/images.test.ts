jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(async () => {}),
}));

import * as RNFS from '@dr.pogodin/react-native-fs';
import { materializeToolResult } from '../images';

test('saves an image tool result and keeps the base64 out of the model text', async () => {
  const materialized = await materializeToolResult({
    content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, { type: 'text', text: 'caption' }],
  });
  expect(RNFS.writeFile).toHaveBeenCalledWith(expect.stringMatching(/^\/docs\/mcp-images\/.+\.png$/), 'aGVsbG8=', 'base64');
  const text = materialized.content?.map(item => item.text).join('\n');
  expect(text).toContain('caption');
  expect(text).toContain('/docs/mcp-images/');
  expect(text).not.toContain('aGVsbG8=');
});
