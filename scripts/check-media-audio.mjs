// Synthetic PCM/ASR and temporary state only. No native inference or chat access.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentCodecs } from '../lib/content-codecs.mjs';
import { MediaAudio, audioSelection } from '../lib/media-audio.mjs';
import { MediaDecoder } from '../lib/media-decoder.mjs';
import { MessageMedia } from '../lib/message-media.mjs';
import { acquireAudioSlot, withAudioSlot } from '../lib/audio-slot.mjs';
import { ReplyBridge } from '../lib/reply-bridge.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 400; n++) { if (predicate()) return; await delay(5); } throw Error('FIXTURE_TIMEOUT'); }
async function wait(promise, signal) {
  signal.throwIfAborted(); let abort;
  try { await Promise.race([promise, new Promise((_, reject) => { abort = () => reject(Error('AUDIO_ABORTED')); signal.addEventListener('abort', abort, { once: true }); })]); }
  finally { signal.removeEventListener('abort', abort); }
}
const root = await mkdtemp(join(tmpdir(), 'watch-media-audio-'));
const store = { root, read: async () => ({ allowed: true, listen: true }) };
let bridge, reader;
try {
  assert.deepEqual(audioSelection({ start: 10, end: 20 }), { start: 10, end: 20 });
  for (const args of [{}, { start: 1, end: 1 }, { start: 0, end: 10, interval: 1 }, { start: 0, end: 10, timestamps: [] }]) assert.throws(() => audioSelection(args), /MEDIA_SELECTION_INVALID/);
  assert.throws(() => audioSelection({ start: 0, end: 121 }), /AUDIO_DURATION_LIMIT/);
  const release = await acquireAudioSlot(store);
  await assert.rejects(acquireAudioSlot(store), /AUDIO_DECODER_BUSY/);
  release(); release();
  await assert.rejects(withAudioSlot(store, async () => { throw Error('FIXTURE_FAILURE'); }), /FIXTURE_FAILURE/);
  (await acquireAudioSlot(store))();

  // The internal source keeps the original file and maps frame-relative seconds
  // to the container's input timeline before extracting timestamp-preserved PCM.
  let probeFile, extractedFile, extractedOptions;
  const demuxer = new MediaDecoder({ run: async (_command, args) => {
    probeFile = args[args.indexOf('-i') + 1];
    return Buffer.from(JSON.stringify({ format: { start_time: '5' }, streams: [
      { codec_type: 'video', width: 16, height: 16, duration: '60', start_time: '8' },
      { codec_type: 'audio', start_time: '9' }] }));
  }, fileSource: (file, options) => {
    extractedFile = file; extractedOptions = options;
    return contentCodecs.stream('audio.pcm', []);
  } });
  const opened = await demuxer.open(Buffer.from('0000ftypfixture'));
  assert.equal(opened.metadata.hasAudio, true);
  await opened.audio({ start: 10, end: 20 }).collect();
  assert.equal(extractedFile, probeFile); assert.equal(extractedOptions.startSeconds, 13);
  assert.equal(extractedOptions.durationSeconds, 10); assert.equal(extractedOptions.inputFormat, 'mov');
  assert.equal(extractedOptions.preserveTimeline, true); await opened.close();

  let allowed = true, retained = true, downloads = 0, audioStarts = 0, closes = 0, sourceCalls = 0;
  let segmentGate = deferred(), videoGate = deferred(), closeGate, quiet = false;
  const sourceWindows = [], decoderOptions = [], notices = [];
  const audio = new MediaAudio({ config: { modelDir: 'fixture', vadModel: 'fixture' }, store,
    createDecoder: () => ({ decode: (pcm, options) => {
      audioStarts++; decoderOptions.push(options);
      return contentCodecs.stream('audio.transcript', (async function* () {
        for await (const packet of pcm) assert.equal(packet.sampleRate, 16000);
        if (quiet) return;
        const first = { start_seconds: options.offsetSeconds, end_seconds: options.offsetSeconds + 0.5, text: 'fixture words' };
        yield first; yield first; // Exact duplicate segments must not duplicate evidence.
        await wait(segmentGate.promise, options.signal);
        yield { start_seconds: options.offsetSeconds + 1, end_seconds: options.offsetSeconds + 1.5, text: 'next words' };
      })());
    }, close: async () => { if (closeGate) await closeGate.promise; closes++; } }) });
  bridge = await ReplyBridge.open();
  let binding = bridge.bind({ id: randomUUID(), mediaEvent: event => { notices.push(event); } });
  const controller = new AbortController();
  let mediaOpened;
  const context = { scope: 'group:fixture', eventSocket: bridge.path, store, audio,
    records: { attachmentDetail: async () => retained ? { attachment: { type: 'video', size: 12 }, messageId: 'fixture', historical: true } : null,
      attachment: async () => ({ url: 'https://fixture.invalid/received' }) },
    download: async () => { downloads++; return Buffer.from('0000ftypfixture'); },
    decoder: { open: async (_bytes, { signal }) => {
      mediaOpened = { metadata: { durationSeconds: 60, hasAudio: true },
        stream: async function* (selection) {
          if (!selection.timestamps.length) return;
          await wait(videoGate.promise, signal);
          yield { timestamp: 10, bytes: Buffer.from('fixture image'), mimeType: 'image/png' };
        }, audio: (selection, { signal }) => {
          sourceCalls++; sourceWindows.push(selection); signal.throwIfAborted();
          return contentCodecs.value('audio.pcm', { samples: new Float32Array(160), sampleRate: 16000 });
        }, close: async () => {} };
      return mediaOpened;
    } } };
  store.read = async () => ({ allowed, listen: allowed });
  reader = new MessageMedia(context);
  const source = { turn_id: binding.turn.id, attachment_id: 'a'.repeat(32) };
  const visual = await reader.read({ ...source, timestamps: [10] });
  await until(() => mediaOpened);
  assert.equal(audioStarts, 0); assert.equal(sourceCalls, 0); // ASR is strictly opt-in.
  const args = { ...source, track: 'audio', start: 10, end: 20 };
  const pending = (await reader.read(args))[0].single(); assert.equal(pending.status, 'pending');
  assert.equal(pending.media_id, visual[0].single().media_id);
  await until(() => notices.some(n => n.track === 'audio' && n.kind === 'media_progress'));
  assert.equal(downloads, 1); assert.equal(audioStarts, 1);
  assert.deepEqual(sourceWindows[0], { start: 9.75, end: 20.25 });
  assert.equal(decoderOptions[0].offsetSeconds, 9.75);
  const partial = (await reader.read(args))[0].single();
  assert.equal(partial.status, 'pending'); assert.equal(partial.segments.length, 1); assert.equal(partial.segments[0].start_seconds, 9.75);
  assert.equal(partial.segments[0].contextOverlap, true); assert.equal(partial.frameCount, 0);
  allowed = false; await assert.rejects(reader.read(args), /GROUP_MESSAGES_DISABLED/); allowed = true;
  retained = false; await assert.rejects(reader.read(args), /ATTACHMENT_NOT_RETAINED/); retained = true;
  segmentGate.resolve(); await until(() => notices.some(n => n.track === 'audio' && n.kind === 'media_ready'));
  const ready = (await reader.read(args))[0].single();
  assert.equal(ready.status, 'ready'); assert.equal(ready.segments.length, 2); assert.equal(ready.speechStatus, 'TRANSCRIBED');
  assert.equal(audioStarts, 1); assert.equal(closes, 1); (await acquireAudioSlot(store))();
  // The visual query is still blocked while the audio query has fully completed.
  assert.equal((await reader.read({ ...source, timestamps: [10] }))[0].single().status, 'pending');
  videoGate.resolve();

  const noAudio = new MediaAudio({ store });
  await assert.rejects(Array.fromAsync(noAudio.stream({ metadata: { hasAudio: false } }, { start: 0, end: 1 }, { signal: controller.signal, assertAccess: async () => {} })), /MEDIA_AUDIO_STREAM_MISSING/);
  await assert.rejects(Array.fromAsync(noAudio.stream(mediaOpened, { start: 0, end: 1 }, { signal: controller.signal, assertAccess: async () => {} })), /AUDIO_LOCAL_NOT_CONFIGURED/);
  await assert.rejects(Array.fromAsync(audio.stream(mediaOpened, { start: 0, end: 61 }, { signal: controller.signal, assertAccess: async () => {} })), /MEDIA_TIMESTAMP_OUT_OF_RANGE/);
  const busyRelease = await acquireAudioSlot(store);
  await reader.read({ ...args, start: 20, end: 25 });
  await until(() => notices.some(n => n.kind === 'media_error' && n.code === 'AUDIO_DECODER_BUSY'));
  busyRelease();
  const busy = (await reader.read({ ...args, start: 20, end: 25 }))[0].single();
  assert.equal(busy.code, 'AUDIO_DECODER_BUSY'); assert.equal(audioStarts, 1); // No implicit retry.

  quiet = true;
  const silentArgs = { ...args, start: 45, end: 50 };
  const silent = (await reader.read(silentArgs))[0].single();
  await until(() => notices.some(n => n.request_id === silent.request_id && n.kind === 'media_ready'));
  assert.equal((await reader.read(silentArgs))[0].single().speechStatus, 'NO_SPEECH_DETECTED');
  quiet = false;

  // Turn completion cancels ongoing ASR, awaits model exit, then frees the shared slot.
  segmentGate = deferred(); closeGate = deferred();
  await reader.read({ ...args, start: 30, end: 40 }); await until(() => audioStarts === 3);
  let ended = false; const ending = binding.close().then(() => { ended = true; });
  await delay(20); assert.equal(ended, false);
  await assert.rejects(acquireAudioSlot(store), /AUDIO_DECODER_BUSY/);
  closeGate.resolve(); await ending;
  assert.equal(reader.sessions.size, 0); assert.equal(reader.cacheBytes, 0); assert.equal(closes, 3);
  (await acquireAudioSlot(store))();
  binding = bridge.bind({ id: randomUUID(), mediaEvent: () => {} });
  await assert.rejects(reader.read({ turn_id: binding.turn.id, media_id: pending.media_id, track: 'audio', start: 10, end: 20 }), /MEDIA_NOT_OPEN/);
  await binding.close();
  // Saved public audio reuses the attachment decoder/slot and source guards.
  const { Store } = await import('../lib/store.mjs');
  const { StoredFiles } = await import('../lib/stored-files.mjs');
  const { MessageAudio } = await import('../lib/message-audio.mjs');
  const audioStore = new Store(join(root, 'saved-audio'));
  const savedScope = 'group:saved';
  const { scopeId } = await import('../lib/policy.mjs');
  const groupPath = join(audioStore.root, 'groups', `${scopeId(savedScope)}.json`);
  await audioStore.write(groupPath, { allowed: true, listen: true });
  const files = new StoredFiles(audioStore, savedScope);
  await files.save('source.mp3', [Buffer.from('ID3synthetic audio')], { provenance: { kind: 'public_download' } });
  let decoded = 0, audioClosed = 0, revokeSaved = false;
  const savedAudio = new MessageAudio({ scope: savedScope, store: audioStore, records: {},
    config: { modelDir: 'fixture', vadModel: 'fixture' },
    download: async () => { throw new Error('NETWORK_NOT_ALLOWED'); },
    fileSource: () => contentCodecs.stream('audio.pcm', [{ samples: new Float32Array(10), sampleRate: 16000 }]),
    createDecoder: () => ({ close: async () => { audioClosed++; }, decode: async function* (source) {
      for await (const packet of source) { assert(packet); decoded++; }
      if (revokeSaved) await audioStore.write(groupPath, { allowed: false });
      yield { text: 'Synthetic public speech', start_seconds: 0, end_seconds: 1 };
    } }),
  });
  const savedResult = await savedAudio.detail(undefined, 'local', { fileName: 'source.mp3' });
  assert.equal(savedResult.file_name, 'source.mp3'); assert.equal(savedResult.status, 'TRANSCRIBED');
  assert.equal(decoded, 1); assert.equal(audioClosed, 1);
  await assert.rejects(savedAudio.detail(undefined, 'qq', { fileName: 'source.mp3' }), /AUDIO_SOURCE_INVALID/);
  await assert.rejects(savedAudio.detail('a'.repeat(32), 'local', { fileName: 'source.mp3' }), /AUDIO_SOURCE_INVALID/);
  revokeSaved = true;
  await assert.rejects(savedAudio.detail(undefined, 'local', { fileName: 'source.mp3' }), /GROUP_MESSAGES_DISABLED/);
  assert.equal(audioClosed, 2); await savedAudio.close();
  console.log('Offline video-audio checks passed: opt-in/shared source, independent queues, original timeline/context, partial cache/dedup, access checks, no-audio/config/range/busy errors, acknowledged cleanup and shared slot ownership. No actual ASR/media/model/QQ call.');
} finally { await reader?.close(); await bridge?.close(); await rm(root, { recursive: true, force: true }); }
