// Offline endpoint checks: synthetic streams, stub tools, no model or platform I/O.
import assert from 'node:assert/strict';
import { contentCodecs } from '../lib/content-codecs.mjs';
import { toolRegistrar, toolFailure } from '../lib/tools/register.mjs';
import { registerWebTools } from '../lib/tools/web.mjs';
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

// Tool families depend only on group/reply capabilities; project reads use file-area guards.
for (const group of [false, true]) for (const replies of [false, true]) {
  const policy = toolPolicy(group, replies);
  assert.equal(Object.hasOwn(policy, 'recall_group_context'), group);
  assert.equal(Object.hasOwn(policy, 'compact_group_context'), group);
  assert.equal(Object.hasOwn(policy, 'send_reply'), replies);
  assert(Object.hasOwn(policy, 'read_file'));
}

// Exercise actual mixed-media and custom failure handlers through the endpoint.
registerWebTools(toolRegistrar(server, toolPolicy()), {}, {
  scope: 'group:fixture', store: { root: '/fixture', read: async () => ({ allowed: true }) },
  webSession: {
    readMedia: async () => ({ image: image.bytes, seconds: 1, capture: 'video_element', url: 'https://github.com/fixture' }),
    listMedia: async () => { throw new Error('WEB_MEDIA_STALE'); },
  },
  stageImages: { ensure: async () => {}, save: async (_scope, _image, options) => {
    assert.equal(options.shareable, false); return { asset_id: 'fixture' };
  } },
});
const frame = await tools.get('read_webpage_media').action({ media_id: 'fixture', turn_id: 'fixture', capture: true, seconds: 1 });
assert.equal(frame.isError, undefined);
assert.deepEqual(frame.content.map(block => block.type), ['text', 'text', 'image']);
assert.equal(JSON.parse(frame.content[0].text).asset.asset_id, 'fixture');
assert.equal(JSON.parse(frame.content[1].text).source.kind, 'webpage_media');
const mediaError = await tools.get('list_webpage_media').action({ turn_id: 'fixture' });
assert.equal(mediaError.isError, true);
assert.equal(JSON.parse(mediaError.content[0].text).code, 'WEB_MEDIA_STALE');
for (const removed of ['discover_videos', 'select_video', 'get_frames', 'get_subtitles', 'remember_video', 'recall_videos']) {
  assert(!Object.hasOwn(toolPolicy(), removed));
}
console.log('MCP codecs: offline endpoint checks passed.');

// Composition registers exactly the approved tools for each lane; construction
// and close use fresh state without invoking a browser, model or transport.
{
  const { createBotMcp } = await import('../lib/mcp.mjs');
  const { Store } = await import('../lib/store.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'mcp-composition-'));
  try {
    for (const group of [false, true]) for (const replies of [false, true]) {
      const app = createBotMcp({ scope: `${group ? 'group' : 'c2c'}:fixture`, store: new Store(root),
        eventSocket: '/fixture-events', replySocket: replies ? '/fixture-replies' : null });
      assert.deepEqual(Object.keys(app.server._registeredTools).sort(), Object.keys(toolPolicy(group, replies)).sort());
      await app.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Preserve safe native and nested acquisition codes at the MCP consumer boundary.
for (const original of [
  Object.assign(new Error('private URL and exception detail'), { code: 'ECONNRESET' }),
  new Error('fetch failed', { cause: Object.assign(new Error('private hostname'), { code: 'ENOTFOUND' }) }),
]) {
  register('failure', '', {}, async () => { throw original; });
  const result = await tools.get('failure').action({});
  assert.equal(JSON.parse(result.content[0].text).code, original.code ?? original.cause.code);
  assert(!JSON.stringify(result).includes('private'));
}
const cyclic = new Error('private body'); cyclic.cause = cyclic;
assert.equal(toolFailure(cyclic).content[0].single().code, 'TOOL_FAILED');
assert.equal(toolFailure({ code: 'https://private.example/secret' }).content[0].single().code, 'TOOL_FAILED');
