// Offline fixtures only: no media playback, real chat records, model or QQ calls.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MessageMedia } from '../lib/message-media.mjs';
import { MediaDecoder, mediaSelection, pngFrames } from '../lib/media-decoder.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { ConversationEvents } from '../lib/conversation-events.mjs';
import { registerMessageMediaTools } from '../lib/tools/message-media.mjs';
import { toolApprovals } from '../lib/tool-policy.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 400; n++) { if (predicate()) return; await delay(5); } throw new Error('FIXTURE_TIMEOUT'); }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
const root = await mkdtemp(join(tmpdir(), 'watch-media-check-'));
let bridge, media;
try {
  assert.deepEqual(mediaSelection({ timestamps: [2, 0, 2, 1] }), { timestamps: [0, 1, 2] });
  assert.deepEqual(mediaSelection(), { timestamps: [] });
  assert.throws(() => mediaSelection({ start: 0, end: 100, interval: 1 }), /MEDIA_QUERY_TOO_LARGE/);
  assert.throws(() => mediaSelection({ timestamps: [], start: 0 }), /MEDIA_SELECTION_INVALID/);
  assert.throws(() => mediaSelection({ start: 0, end: 1, interval: 0 }), /MEDIA_SELECTION_INVALID/);
  const packed = Buffer.concat([png, png, png, png]);
  async function* chunks() { for (let i = 0; i < packed.length; i += 7) yield packed.subarray(i, i + 7); }
  assert.equal((await Array.fromAsync(pngFrames(chunks()))).length, 4);
  await assert.rejects(Array.fromAsync(pngFrames([png.subarray(0, 20)])), /MEDIA_FRAME_INVALID/);

  // Stub native child emits four PNGs before delayed stderr timestamps. This
  // verifies cross-pipe pairing, iterator close, temp lifetime and process errors.
  const executable = join(root, 'fake-ffmpeg');
  const escaped = [...Buffer.concat([png, png, png, png])].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('');
  await writeFile(executable, `#!/bin/sh
printf '${escaped}'
/bin/sleep 0.02
printf '[Parsed_showinfo_3 @ fixture] n: 0 pts: 0 pts_time:0\\n[Parsed_showinfo_3 @ fixture] n: 1 pts: 1 pts_time:0.25\\n[Parsed_showinfo_3 @ fixture] n: 2 pts: 2 pts_time:0.5\\n[Parsed_showinfo_3 @ fixture] n: 3 pts: 3 pts_time:0.75\\n' >&2
`, { mode: 0o700 });
  let input;
  const decoder = new MediaDecoder({ ffmpeg: executable, run: async (_command, args) => {
    input = args[args.indexOf('-i') + 1];
    return Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', width: 1, height: 1, duration: '2' }] }));
  } });
  const opened = await decoder.open(Buffer.from('GIF89afixture'));
  await access(input);
  const decoded = await Array.fromAsync(opened.stream({ timestamps: [0, 0.2, 0.4, 0.6] }));
  assert.deepEqual(decoded.map(f => f.timestamp), [0, 0.25, 0.5, 0.75]);
  const early = opened.stream({ timestamps: [0] }); await early.next(); await early.return();
  await assert.rejects(Array.fromAsync(opened.stream({ timestamps: [3] })), /MEDIA_TIMESTAMP_OUT_OF_RANGE/);
  await opened.close(); await assert.rejects(access(input));

  bridge = await ReplyBridge.open();
  const inbox = new ConversationEvents({ graceMs: 10 }); let wakes = 0, interrupts = 0;
  const eventTurn = inbox.begin({ wake: () => wakes++, interrupt: () => interrupts++, canReadMessages: true });
  inbox.guard(eventTurn, true);
  let binding = bridge.bind({ id: randomUUID(), mediaEvent: event => inbox.notify(eventTurn, event) });
  let allowed = true, retained = true, opens = 0, downloads = 0, streams = 0, closed = 0;
  let openGate = deferred(), frameGate = deferred(), closeGate, streamFailure = false;
  const abortable = (promise, signal) => Promise.race([promise, new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('MEDIA_ABORTED'));
    else signal.addEventListener('abort', () => reject(new Error('MEDIA_ABORTED')), { once: true });
  })]);
  const context = { scope: 'group:fixture', eventSocket: bridge.path,
    store: { root, read: async () => ({ allowed, listen: allowed }) },
    records: { attachmentDetail: async () => retained ? { attachment: { type: 'video', size: 12 }, messageId: 'fixture', historical: true } : null,
      attachment: async () => ({ url: 'https://fixture.invalid/private' }) },
    images: { load: async (_scope, _id, check) => { await check({ historical: true }); return { bytes: Buffer.from('GIF89afixture'),
      source: { kind: 'qq_group_image', imageId: 'b'.repeat(32) }, assertAccess: () => check({ historical: true }) }; } },
    download: async () => { downloads++; return Buffer.from('0000ftypfixture'); },
    decoder: { open: async (_bytes, { signal }) => {
      opens++; await abortable(openGate.promise, signal);
      return { metadata: { durationSeconds: 10 }, stream: async function* () {
        streams++; yield { timestamp: 0.125, bytes: png, mimeType: 'image/png' };
        await abortable(frameGate.promise, signal);
        if (streamFailure) throw new Error('MEDIA_DECODE_FAILED');
        for (let n = 1; n < 6; n++) { signal.throwIfAborted(); yield { timestamp: n + 0.125, bytes: png, mimeType: 'image/png' }; }
      }, close: async () => { if (closeGate) await closeGate.promise; closed++; } };
    } } };
  media = new MessageMedia(context);
  const args = { turn_id: binding.turn.id, attachment_id: 'a'.repeat(32), timestamps: [0, 1, 2, 3, 4, 5] };
  const first = (await media.read(args))[0].single(); assert.equal(first.status, 'pending');
  const second = (await media.read({ ...args, timestamps: [5, 4, 3, 2, 1, 0] }))[0].single();
  assert.equal(first.media_id, second.media_id); assert.equal(first.request_id, second.request_id);
  await until(() => opens === 1); assert.equal(downloads, 1);
  openGate.resolve(); await until(() => [...media.sessions.values()][0].queries.values().next().value.frames.length === 1);
  const partial = await media.read(args); assert.equal(partial[0].single().status, 'pending'); assert.equal(partial.length, 2);
  assert.equal(partial[1].single().source.timestampSeconds, 0.125);
  inbox.add('message', 'message', async () => ({ text: 'fixture' })); await delay(20);
  assert.equal(interrupts, 0); assert(wakes >= 2); assert.equal((await inbox.read(eventTurn)).events.length, 1);
  frameGate.resolve(); await until(() => [...media.sessions.values()][0].queries.values().next().value.status === 'ready');
  const ready = await media.read(args); assert.equal(ready[0].single().status, 'ready'); assert.equal(ready.length, 7);
  assert.equal(streams, 1); assert.equal(opens, 1);
  allowed = false; await assert.rejects(media.read(args), /GROUP_MESSAGES_DISABLED/); allowed = true;
  retained = false; await assert.rejects(media.read(args), /ATTACHMENT_NOT_RETAINED/); retained = true;
  await media.closeMedia({ turn_id: args.turn_id, media_id: first.media_id }); assert.equal(media.cacheBytes, 0); assert.equal(closed, 1);
  await media.closeMedia({ turn_id: args.turn_id, media_id: first.media_id }); assert.equal(closed, 1);

  // Acquisition failure is a stable cached error, with no duplicate retry/task.
  retained = false;
  const failedArgs = { ...args, attachment_id: 'c'.repeat(32) };
  await media.read(failedArgs);
  await until(() => [...media.sessions.values()][0].queries.values().next().value.status === 'error');
  const failed = (await media.read(failedArgs))[0].single();
  assert.equal(failed.code, 'ATTACHMENT_NOT_RETAINED'); assert.equal(downloads, 1);
  await media.closeMedia({ turn_id: args.turn_id, media_id: failed.media_id }); retained = true;

  // Decoder failure preserves published frames, reports error, and does not poison later work.
  streamFailure = true;
  await media.read(args);
  await until(() => [...media.sessions.values()][0].queries.values().next().value.status === 'error');
  const partialError = await media.read(args);
  assert.equal(partialError[0].single().code, 'MEDIA_DECODE_FAILED');
  assert.equal(partialError.length, 2); assert.equal(media.cacheBytes, png.length);
  await media.closeMedia({ turn_id: args.turn_id, media_id: partialError[0].single().media_id });
  assert.equal(media.cacheBytes, 0); streamFailure = false;

  // Completion aborts an in-flight iterator and awaits actual decoder cleanup.
  openGate = deferred(); openGate.resolve(); frameGate = deferred(); closeGate = deferred();
  const gifArgs = { turn_id: args.turn_id, image_id: 'b'.repeat(32), timestamps: [0, 1] };
  await media.read(gifArgs);
  await until(() => streams === 3);
  let finished = false;
  const completion = binding.close().then(() => { finished = true; });
  await delay(20); assert.equal(finished, false);
  closeGate.resolve(); await completion;
  assert.equal(media.cacheBytes, 0); assert.equal(media.sessions.size, 0); assert.equal(media.turnId, null);
  assert.equal(closed, 3);
  assert.equal((await callReplyBridge(bridge.path, { turn_id: args.turn_id, action: 'media_check' })).code, 'REPLY_TURN_EXPIRED');
  // Same process can accept a new turn, but old session IDs never survive.
  binding = bridge.bind({ id: randomUUID(), mediaEvent: () => {} });
  await assert.rejects(media.read({ turn_id: binding.turn.id, media_id: first.media_id }), /MEDIA_NOT_OPEN/);
  // Turn closure racing an authorization await must not create a late job/session.
  const authorization = deferred(); let checking = false;
  context.store.read = async () => { checking = true; await authorization.promise; return { allowed: true, listen: true }; };
  const late = media.read({ turn_id: binding.turn.id, image_id: 'd'.repeat(32) });
  late.catch(() => {});
  await until(() => checking);
  await binding.close(); authorization.resolve();
  await assert.rejects(late, /MEDIA_TURN_EXPIRED/); assert.equal(media.sessions.size, 0);
  context.store.read = async () => ({ allowed: true, listen: true });
  binding = bridge.bind({ id: randomUUID(), mediaEvent: () => {} });
  await assert.rejects(media.read({ turn_id: binding.turn.id, media_id: first.media_id }), /MEDIA_NOT_OPEN/);
  const disconnected = await media.subscription; await disconnected.close();
  await delay(0);
  await assert.rejects(binding.close(), /MEDIA_CLEANUP_FAILED/);
  inbox.close();

  const tools = new Map(); const closeTools = registerMessageMediaTools((name, _description, schema) => tools.set(name, schema), context);
  assert.deepEqual([...tools.keys()], ['read_media', 'close_media']);
  for (const name of tools.keys()) assert(toolApprovals().enabled_tools.includes(name));
  assert(!toolApprovals().enabled_tools.includes('get_media_frames'));
  await closeTools();
  console.log('Offline media checks passed: PNG chunk framing, actual timestamps, >3 frames, pending/dedup/cache, guarded notifications, revocation, stable errors, explicit close and acknowledged turn cleanup. Actual media decoding and live model/QQ behavior were not exercised.');
} finally { await media?.close(); await bridge?.close(); await rm(root, { recursive: true, force: true }); }
