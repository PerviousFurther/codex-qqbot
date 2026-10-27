import { contentCodecs } from './content-codecs.mjs';

// Endpoint encoding runs only at the MCP boundary. Units remain block arrays.
contentCodecs
  .register('text', 'mcp.content', text => [{ type: 'text', text }])
  .register('json', 'mcp.content', value => contentCodecs.value('json', value)
    .to('text').to('mcp.content').single())
  .register('image', 'mcp.content', ({ bytes, mimeType, source }) => [
    ...contentCodecs.value('json', { source, untrusted: true }).to('mcp.content').single(),
    { type: 'image', mimeType, data: bytes.toString('base64') },
  ]);
