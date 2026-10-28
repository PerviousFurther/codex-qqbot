// Offline synthetic files, temporary state and fake encoder/download transports only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { Files } from '../lib/files.mjs';
import { StoredFiles } from '../lib/stored-files.mjs';
import { WorkspaceFiles } from '../lib/workspace-files.mjs';
import { SavedImages } from '../lib/saved-images.mjs';
import { TurnImages } from '../lib/turn-images.mjs';
import { FileMediaEncoder } from '../lib/file-media-encoder.mjs';
import { fileType } from '../lib/file-codecs.mjs';
import { registerFileTools } from '../lib/tools/files.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';
import { RequestUpdates } from '../lib/request-updates.mjs';
import { resolveReplyMedia } from '../lib/reply-media.mjs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { MessageMedia } from '../lib/message-media.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { createBotMcp } from '../lib/mcp.mjs';
import { MediaTurnHub } from '../lib/media-turn.mjs';
import { FileManagement } from '../lib/file-management.mjs';
import { scopeId } from '../lib/policy.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-files-')); const store = new Store(root); const scope = 'c2c:fixture';
const png = Buffer.from([137,80,78,71,13,10,26,10,0]); const mp4 = Buffer.from('0000ftypisom0000'); const mp3 = Buffer.from('ID3fixture');
let encodes = 0; let qqChecks = true;
const savedImages = new SavedImages(store);
const records = { attachment: async () => qqChecks ? { url: 'https://gchat.qpic.cn/fixture', kind: 'video', historical: false } : null };
const downloadQQ = async (_url, _limit, { consume }) => consume([mp4]);
const encoder = { encode: async (_path, { format }) => { encodes++; return { duration: 2, stream: [format === 'audio' ? mp3 : format === 'gif' ? Buffer.from('GIF89afixture') : mp4] }; } };
const files = new Files({ scope, store, records, savedImages, encoder, downloadQQ }); const workspace = files.workspace;
try {
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: true });
  await new WorkspaceFiles(store, scope).write('old.md', 'legacy');
  assert.equal(await workspace.readText('old.md'), 'legacy');
  const unicode = Buffer.from('字😀\nsecond');
  await workspace.save('split.txt', [unicode.subarray(0, 5), unicode.subarray(5)]);
  assert.equal(await workspace.readText('split.txt'), '字😀\nsecond');
  assert.equal((await files.read('split.txt', 'workspace', 2, 1))[0].single().content, 'second');
  await assert.rejects(workspace.save('split.txt', [Buffer.from('replacement')]), /WORKSPACE_FILE_EXISTS/);
  await assert.rejects(workspace.save('split.txt', [Buffer.from([255])], { overwrite: true }), /FILE_UTF8_REQUIRED/);
  await assert.rejects(workspace.save('split.txt', [Buffer.alloc(65537)], { overwrite: true }), /FILE_TOO_LARGE/);
  assert.equal(await workspace.readText('split.txt'), '字😀\nsecond');
  await files.save({ name: 'note.md', text: 'local' });
  // A shared alias must never fall through to a current-chat attachment when
  // the standalone owner has no active cross-chat authorization channel.
  await assert.rejects(files.save({ name: 'denied.mp4', attachment_id: '1'.repeat(32),
    context_chat: `chat:${randomUUID()}`, turn_id: randomUUID() }), /CONTEXT_TARGET_UNAVAILABLE/);
  await files.save({ area: 'memory', name: 'public.md', text: 'public note' });
  await assert.rejects(files.save({ area: 'memory', name: 'AGENTS.md', text: 'replace', overwrite: true }), /MEMORY_GUIDE_READ_ONLY/);
  await assert.rejects(files.save({ area: 'memory', name: 'private.md', attachment_id: '1'.repeat(32) }), /MEMORY_GENERATED/);
  await assert.rejects(files.save({ name: '../escape', text: 'x' }), /WORKSPACE_NAME_INVALID/);
  await assert.rejects(files.save({ name: 'fake.png', text: 'not pixels' }), /FILE_TEXT_REQUIRED/);
  await assert.rejects(workspace.save('fake.png', [Buffer.from('not pixels')]), /IMAGE_FORMAT_UNSUPPORTED/);
  assert.equal(fileType('file.constructor').kind, 'binary');
  const before = await readdir(await workspace.directory());
  const cancellation = new AbortController();
  await assert.rejects(workspace.save('cancel.bin', (async function* () { yield Buffer.from('a'); cancellation.abort(); yield Buffer.from('b'); })(), { signal: cancellation.signal }));
  assert.deepEqual(await readdir(await workspace.directory()), before);
  const results = await Promise.allSettled([new StoredFiles(store, scope).save('race.txt', [Buffer.from('a')]), new StoredFiles(store, scope).save('race.txt', [Buffer.from('b')])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await workspace.list()).files.filter(f => f.name === 'race.txt').length, 1);
  await files.save({ name: 'qq.mp4', attachment_id: '1'.repeat(32) }); assert.equal(encodes, 0);
  await files.save({ name: 'qq-compressed.mp4', attachment_id: '1'.repeat(32), bitrate_kbps: 300 }); assert.equal(encodes, 1);
  await files.save({ name: 'speech.mp3', attachment_id: '1'.repeat(32), format: 'audio' }); assert.equal(encodes, 2);
  assert.equal((await files.read('qq.mp4'))[0].single().kind, 'video');
  const asset = await savedImages.save(scope, png, { label: 'public pixels', source: { kind: 'public_image' }, shareable: true });
  await files.save({ name: 'saved.png', asset_id: asset.asset_id });
  assert.equal((await files.read('saved.png'))[1].single().bytes.length, png.length);
  assert.equal((await resolveReplyMedia(scope, { type: 'image', file_name: 'saved.png' }, { store }, () => true, { crossConversation: true })).bytes.length, png.length);
  const privateFiles = new Files({ scope, store, messageImages: { load: async () => ({ bytes: png,
    source: { kind: 'qq_private_image', historical: false }, assertAccess: async () => {} }) } });
  await privateFiles.save({ name: 'private.png', image_id: '2'.repeat(32), label: 'private fixture' });
  await assert.rejects(resolveReplyMedia(scope, { type: 'image', file_name: 'private.png' }, { store }, () => true, { crossConversation: true }), /CROSS_CONVERSATION_ASSET_DISABLED/);
  await files.save({ name: 'chat.mp4', attachment_id: '1'.repeat(32), format: 'original' });
  const snap = await workspace.load('chat.mp4');
  await workspace.removeFile('chat.mp4', snap.sha256); await assert.rejects(snap.assertAccess());
  await assert.rejects(new StoredFiles(store, 'c2c:other').load('saved.png'));
  const dir = await workspace.directory(); await symlink('/tmp', join(dir, 'link.txt'));
  await assert.rejects(workspace.save('link.txt', [Buffer.from('no')], { overwrite: true }), /WORKSPACE_REGULAR_FILE_REQUIRED/);
  let endTurn;
  const staged = new TurnImages({ savedImages, eventSocket: 'fake', watch: async (_path, _id, cleanup) => {
    endTurn = cleanup; return { check: async () => {}, assertActive() {}, close: cleanup };
  } });
  const transient = await staged.save(scope, png, { turnId: 'fixture-turn', source: { kind: 'webpage_screenshot' } });
  assert(transient.temporary); await files.save({ name: 'keep.png', asset_id: transient.asset_id });
  await endTurn(); await assert.rejects(savedImages.get(scope, transient.asset_id), /NOT_RETAINED/);
  assert.equal((await workspace.load('keep.png')).bytes.length, png.length); await staged.close();
  const bridge = await ReplyBridge.open(); const delivered = [];
  const binding = bridge.bind({ id: randomUUID(), mediaEvent() {}, send: async (text, target, media) => { delivered.push({ text, target, media }); } });
  const hub = new MediaTurnHub(); const watch = hub.watch.bind(hub);
  const realStages = new TurnImages({ savedImages, eventSocket: bridge.path, watch });
  try {
    const part = { turn_id: binding.turn.id, part_id: 1, media: { type: 'image', file_name: 'saved.png' } };
    assert((await callReplyBridge(bridge.path, part)).ok); assert((await callReplyBridge(bridge.path, part)).ok);
    assert.equal(delivered.length, 1); assert.equal(delivered[0].media.file_name, 'saved.png');
    assert.equal((await callReplyBridge(bridge.path, { ...part, media: { type: 'image', file_name: 'private.png' } })).code, 'REPLY_PART_CONFLICT');
    const image = await realStages.save(scope, png, { turnId: binding.turn.id, source: { kind: 'webpage_screenshot' } });
    const released = await watch(bridge.path, binding.turn.id, async () => {});
    await released.close(); await realStages.ensure(scope, binding.turn.id);
    let otherCleaned = false;
    const otherOwner = await watch(bridge.path, binding.turn.id, async () => { otherCleaned = true; });
    await store.write(join(root, 'chat-access.json'), { publicPrivateChat: false });
    await binding.close();
    await store.write(join(root, 'chat-access.json'), { publicPrivateChat: true });
    await assert.rejects(savedImages.get(scope, image.asset_id), /NOT_RETAINED/);
    assert(otherCleaned); await otherOwner.close();
  } finally { await realStages.close(); await bridge.close(); }
  const reader = new MessageMedia({ scope, store, eventSocket: 'fake', watch: async () => ({ check: async () => {}, assertActive() {}, notify: async () => {}, close: async () => {} }),
    decoder: { open: async () => ({ metadata: { durationSeconds: 2 }, stream: async function* () {}, close: async () => {} }) } });
  try {
    const result = await reader.read({ turn_id: 'fixture', file_name: 'qq.mp4' });
    const id = result[0].single().media_id;
    await reader.sessions.get(id).queries.values().next().value.task;
    assert.equal((await reader.read({ turn_id: 'fixture', media_id: id }))[0].single().status, 'ready');
  } finally { await reader.close(); }
  const mcp = createBotMcp({ scope, store, browser: { close: async () => {} } });
  try {
    assert(mcp.server._registeredTools.save_file); assert(mcp.server._registeredTools.read_file);
    assert(!mcp.server._registeredTools.save_image); assert(!mcp.server._registeredTools.read_workspace_file);
  } finally { await mcp.close(); }
  const tools = new Map(); registerFileTools((name, description, schema, run) => tools.set(name, { schema: z.object(schema), run }), { scope, store, savedImages });
  assert.deepEqual([...tools.keys()], ['list_files', 'read_file', 'save_file', 'delete_file']);
  assert(!tools.get('read_file').schema.safeParse({ area: 'project', name: 'x' }).success);
  const found = await tools.get('list_files').run({ area: 'workspace', query: 'PRIVATE FIXTURE' });
  assert.deepEqual(found[0].single().files.map(file => file.name), ['private.png']);
  const operator = { store, admins: ['fixture'] }; const management = new FileManagement(operator);
  const viewCommand = `/files current view ${scopeId('keep.png')}`;
  const view = await management.handle(scope, viewCommand);
  const opening = view.buttons.rows.flat().find(button => button.label === '在私聊打开').command;
  const opened = await management.handle(scope, opening);
  assert.equal(opened.media.bytes.length, png.length); await opened.media.assertAccess();
  operator.admins = []; await assert.rejects(opened.media.assertAccess(), /ADMIN_ACCESS_REVOKED/); operator.admins = ['fixture'];
  const deletion = await management.handle(scope, view.buttons.rows.flat().find(button => button.label === '删除文件').command);
  assert((await management.handle(scope, deletion.buttons.rows.flat().find(button => button.label === '确认删除').command)).text.includes('已删除'));
  await assert.rejects(workspace.load('keep.png'));
  const hints = []; const updates = new RequestUpdates({ toolMonitor: true }, async value => hints.push(value));
  for (const name of tools.keys()) { assert(Object.hasOwn(toolPolicy(), name)); updates.update({ kind: 'tool', name }); updates.update({ kind: 'tool-result', name, status: 'completed', elapsedMs: 1 }); }
  await updates.close(); assert.equal(hints.length, 8);
  const input = join(root, 'synthetic-input'); await writeFile(input, mp4);
  let duration = 2; let starts = 0; let stopped = 0; let args;
  const native = new FileMediaEncoder({ run: async () => Buffer.from(JSON.stringify({ format: { duration }, streams: [{ codec_type: 'video', width: 16, height: 16, bit_rate: 400000 }, { codec_type: 'audio' }] })),
    stream: (_command, argv) => { starts++; args = argv; return { output: [mp4], check: async () => {}, close: async () => { stopped++; } }; } });
  const encoded = await native.encode(input, { format: 'video' }); assert.equal(starts, 0);
  for await (const _ of encoded.stream) {} assert.equal(starts, 1); assert.equal(stopped, 1); assert(args.includes('400k'));
  duration = 16; await assert.rejects(native.encode(input, { format: 'gif' }), /FILE_GIF_DURATION_LIMIT/); assert.equal(starts, 1);
  console.log('Offline file checks passed: streamed validation, atomic overwrite/cancellation/concurrent creation, scope/guide guards, QQ preservation/conversion, temporary browser assets, saved media sends, schema/policy/feedback and synthetic encoder limits.');
} finally { await rm(root, { recursive: true, force: true }); }
