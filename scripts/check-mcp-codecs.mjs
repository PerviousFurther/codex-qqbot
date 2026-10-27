// Offline endpoint checks: synthetic streams, stub tools, no model or platform I/O.
import assert from 'node:assert/strict';
import { contentCodecs } from '../lib/content-codecs.mjs';
import { toolRegistrar, toolFailure } from '../lib/tools/register.mjs';
import { registerVideoTools } from '../lib/tools/video.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';

const tools = new Map();
const server = { registerTool(name, options, action) { tools.set(name, { options, action }); } };
const register = toolRegistrar(server, { mixed: {}, failure: {}, interrupted: {}, empty: {}, legacy: {} });
const source = { kind: 'fixture' };
const image = { bytes: Buffer.from([1, 2, 3]), mimeType: 'image/png', source };
let closed = false;
register('mixed', '', {}, async () => [
  contentCodecs.stream('json', (async function* () {
    try { yield { index: 1 }; yield { index: 2 }; }
    finally { closed = true; }
  })()),
  contentCodecs.value('image', image),
  contentCodecs.value('text', 'last'),
]);
const mixed = await tools.get('mixed').action({});
assert.deepEqual(mixed, { content: [
  { type: 'text', text: '{"index":1}' },
  { type: 'text', text: '{"index":2}' },
  { type: 'text', text: JSON.stringify({ source, untrusted: true }) },
  { type: 'image', mimeType: 'image/png', data: 'AQID' },
  { type: 'text', text: 'last' },
] });
assert(closed);
register('failure', '', {}, async () => { throw new Error('IMAGE_TOO_LARGE'); });
const failure = await tools.get('failure').action({});
assert.equal(failure.isError, true);
assert.equal(JSON.parse(failure.content[0].text).limit_mib, 16);
assert.equal(toolFailure(new Error('fixture private body')).content[0].single().code, 'TOOL_FAILED');

// A failed source cannot leak already buffered bodies as a partial success.
closed = false;
register('interrupted', '', {}, async () => [contentCodecs.stream('json', (async function* () {
  try { yield { secret: 'DO_NOT_RETURN' }; throw new Error('GROUP_MESSAGES_DISABLED'); }
  finally { closed = true; }
})())]);
const interrupted = await tools.get('interrupted').action({});
assert(closed);
assert.equal(interrupted.isError, true);
assert.equal(JSON.parse(interrupted.content[0].text).code, 'GROUP_MESSAGES_DISABLED');
assert(!JSON.stringify(interrupted).includes('DO_NOT_RETURN'));
register('empty', '', {}, async () => []);
assert.deepEqual(await tools.get('empty').action({}), { content: [] });
// Raw protocol blocks are no longer a valid handler return type.
register('legacy', '', {}, async () => [{ type: 'text', text: 'obsolete' }]);
assert.equal((await tools.get('legacy').action({})).isError, true);
assert.throws(() => register('unlisted', '', {}, async () => []), /TOOL_POLICY_REQUIRED/);

// Exercise actual mixed-media and custom failure handlers through the endpoint.
registerVideoTools(toolRegistrar(server, toolPolicy(false, false, false)), {
  scope: 'group:fixture', store: { root: '/fixture', read: async () => ({ allowed: true }) },
  browser: {
    frame: async () => ({ image: image.bytes, seconds: 1, visible_text: [] }),
    discover: async () => { throw Object.assign(new Error('FRAME_TIMEOUT'), {
      accessibleRange: { start: 0, end: 2 }, bilibiliLoggedOut: true,
    }); },
  },
  stageImages: { ensure: async () => {}, save: async () => ({ asset_id: 'fixture' }) },
});
const frame = await tools.get('get_frames').action({ bvid: 'BV1234567890', seconds: 1 });
assert.equal(frame.isError, undefined);
assert.deepEqual(frame.content.map(block => block.type), ['text', 'text', 'image']);
assert.equal(JSON.parse(frame.content[0].text).asset.asset_id, 'fixture');
assert.equal(JSON.parse(frame.content[1].text).source.kind, 'bilibili_frame');
const videoError = await tools.get('discover_videos').action({ query: '' });
assert.equal(videoError.isError, true);
assert.equal(JSON.parse(videoError.content[0].text).code, 'FRAME_TIMEOUT');
assert.deepEqual(JSON.parse(videoError.content[1].text), { accessible_range: { start: 0, end: 2 } });
assert.deepEqual(JSON.parse(videoError.content[2].text), { bilibili_login: 'session_invalid' });
console.log('MCP codecs: offline endpoint checks passed.');
