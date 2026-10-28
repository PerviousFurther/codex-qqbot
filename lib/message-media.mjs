import { MediaAudio, audioSelection } from './media-audio.mjs';
import { randomBytes } from 'node:crypto';
import { MediaDecoder, MAX_VIDEO_BYTES, mediaFormat, mediaSelection } from './media-decoder.mjs';
import { downloadQQMedia } from './qq-images.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { contentCodecs } from './content-codecs.mjs';
import { SerialQueue } from './serial-queue.mjs';
import { watchMediaTurn } from './media-turn.mjs';
import { StoredFiles } from './stored-files.mjs';

const id = () => randomBytes(16).toString('hex');
const code = error => /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message ?? '') ? error.message : 'MEDIA_DECODE_FAILED';
const MAX_CACHE = 32 * 1024 * 1024;

// One turn owns sessions, jobs, cached evidence and the private lifecycle watcher.
export class MessageMedia {
  constructor({ scope, store, records, images, eventSocket, contextAccess, audioConfig = {}, audio, decoder = new MediaDecoder(), download = downloadQQMedia, watch = watchMediaTurn }) {
    Object.assign(this, { scope, store, records, images, eventSocket, contextAccess, decoder, download, watch });
    this.audio = audio ?? new MediaAudio({ config: audioConfig, store });
    this.audioQueue = new SerialQueue();
    this.queue = new SerialQueue(); this.sessions = new Map(); this.cacheBytes = 0;
  }
  async turn(turnId) {
    if (this.closed) throw new Error('MEDIA_READER_CLOSED');
    if (!this.eventSocket) throw new Error('MEDIA_EVENTS_UNAVAILABLE');
    if (this.turnId && this.turnId !== turnId) throw new Error('MEDIA_TURN_BUSY');
    if (!this.turnId) {
      this.turnId = turnId;
      const generation = {}; this.generation = generation;
      this.subscription = this.watch(this.eventSocket, turnId, () => this.clear(generation)).catch(error => {
        if (this.generation === generation) { this.turnId = null; this.subscription = null; } throw error;
      });
    }
    const subscription = await this.subscription; await subscription.check(); return subscription;
  }
  async read(args, { signal } = {}) {
    signal?.throwIfAborted();
    const subscription = await this.turn(args.turn_id);
    await assertMessageAccess(this.scope, this.store);
    subscription.assertActive();
    if ([args.media_id, args.image_id, args.attachment_id, args.file_name].filter(Boolean).length !== 1) throw new Error('MEDIA_SOURCE_INVALID');
    const track = args.track ?? 'video';
    if (!['video', 'audio'].includes(track)) throw new Error('MEDIA_TRACK_INVALID');
    const selection = track === 'audio' ? audioSelection(args) : mediaSelection(args), key = JSON.stringify([track, selection]);
    const sourceKey = args.file_name ? `file:${args.file_name}` : args.image_id || args.attachment_id;
    const access = this.contextAccess ? await this.contextAccess.resolve(args) : { scope: this.scope, check: row => assertMessageAccess(this.scope, this.store, row) };
    if (args.context_chat && args.file_name) throw new Error('MEDIA_SOURCE_INVALID');
    let session = args.media_id ? this.sessions.get(args.media_id) : [...this.sessions.values()].find(s => s.sourceKey === sourceKey && s.isImage === !!args.image_id && s.contextChat === args.context_chat);
    if (!session) {
      if (args.media_id) throw new Error('MEDIA_NOT_OPEN');
      if (this.sessions.size >= 4) throw new Error('MEDIA_CAPACITY');
      const controller = new AbortController();
      session = { id: id(), scope: access.scope, access: access.check, contextChat: args.context_chat, sourceKey, fileName: args.file_name, isImage: !!args.image_id, controller, queries: new Map(), cacheBytes: 0 };
      this.sessions.set(session.id, session);
      session.open = this.queue.run(() => this.acquire(session)).catch(error => { session.error = session.controller.signal.aborted ? 'MEDIA_ABORTED' : session.acquisitionSignal?.aborted ? 'MEDIA_TIMEOUT' : code(error); });
    }
    if (args.context_chat && session.contextChat !== args.context_chat) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
    await session.access();
    if (session.guard) await session.guard();
    subscription.assertActive();
    let query = session.queries.get(key);
    if (!query) {
      if (session.queries.size >= 32) throw new Error('MEDIA_CAPACITY');
      query = { id: id(), track, selection, status: 'pending', frames: [], segments: [], bytes: 0 };
      session.queries.set(key, query);
      const queue = track === 'audio' ? this.audioQueue : this.queue;
      query.task = queue.run(() => this.decodeQuery(subscription, session, query)).catch(async error => {
        query.status = 'error'; query.code = session.controller.signal.aborted ? 'MEDIA_ABORTED' : code(error);
        // Published evidence remains cached even when the remainder fails.
        await this.notify(subscription, session, query, 'media_error');
      });
    }
    // Read only published cache; never await decoder or its queue here.
    await subscription.check(); signal?.throwIfAborted();
    if (session.guard) await session.guard();
    subscription.assertActive();
    const frames = query.frames.slice();
    return [contentCodecs.value('json', { media_id: session.id, request_id: query.id, status: query.status,
      ...(query.code ? { code: query.code } : {}), source: session.source, untrusted: true,
      metadata: session.decoder?.metadata ?? null, track, selection, frameCount: frames.length,
      ...(track === 'audio' ? { sourceType: 'local_asr', segments: query.segments.slice(), segmentCount: query.segments.length,
        speechStatus: query.status === 'ready' ? query.segments.length ? 'TRANSCRIBED' : 'NO_SPEECH_DETECTED' : null,
        limitation: 'Speech transcription only, not music, sound-effect, emotion or speaker identification. VAD segment times refer to the video timeline. Adjacent ranges can repeat boundary context; do not treat that as repeated speech.' } : {}),
      guidance: 'pending means decoding continues. Wait for media events, handle messages/replies meanwhile. Repeat the same selection to read its growing cache; repeated reads replay cached evidence. close_media releases it; turn end releases everything.' }),
    ...frames.map(frame => contentCodecs.value('image', { ...frame, source: { ...session.source, timestampSeconds: frame.timestamp } }))];
  }
  async decodeQuery(subscription, session, query) {
    await session.open;
    if (session.error) throw new Error(session.error);
    await session.guard();
    const audio = query.track === 'audio';
    const stream = audio
      ? contentCodecs.stream('audio.transcript', this.audio.stream(session.decoder, query.selection, { signal: session.controller.signal, assertAccess: session.guard }))
      : contentCodecs.stream('image', session.decoder.stream(query.selection));
    const cache = audio ? query.segments : query.frames;
    for await (const unit of stream) {
      await session.guard();
      const bytes = audio ? Buffer.byteLength(JSON.stringify(unit), 'utf8') : unit.bytes.length;
      if (this.cacheBytes + bytes > MAX_CACHE) throw new Error('MEDIA_CACHE_FULL');
      cache.push(unit); query.bytes += bytes; session.cacheBytes += bytes; this.cacheBytes += bytes;
      if (cache.length === 1 || Date.now() - (query.lastNotice ?? 0) >= 250) {
        query.lastNotice = Date.now(); await this.notify(subscription, session, query, 'media_progress');
      }
    }
    await session.guard(); query.status = 'ready';
    await this.notify(subscription, session, query, 'media_ready');
  }
  async notify(subscription, session, query, kind) {
    if (session.controller.signal.aborted || this.sessions.get(session.id) !== session) return;
    // A notice is a hint. Cache state is authoritative if ready/read/close race.
    try { await subscription.notify({ kind, media_id: session.id, request_id: query.id, track: query.track, frameCount: query.frames.length, segmentCount: query.segments.length, ...(query.code ? { code: query.code } : {}) }); }
    catch { /* Closed turns own cleanup; notifications never start another turn. */ }
  }
  async acquire(session) {
    const signal = AbortSignal.any([session.controller.signal, AbortSignal.timeout(60000)]);
    session.acquisitionSignal = signal;
    const assertAccess = session.access;
    const check = async () => { signal.throwIfAborted(); await assertAccess(); };
    await check(); let bytes, recheck;
    if (session.fileName) {
      const file = await new StoredFiles(this.store, session.scope).load(session.fileName);
      if (file.kind !== 'video' && file.mimeType !== 'image/gif') throw new Error('MEDIA_FORMAT_UNSUPPORTED');
      bytes = file.bytes; session.source = { ...file.source, file_name: file.name }; recheck = file.assertAccess;
    } else if (session.isImage) {
      const archived = await this.records.replyMedia?.(session.scope, session.sourceKey);
      if (archived) {
        if (archived.kind !== 'image') throw new Error('ATTACHMENT_TYPE_MISMATCH');
        bytes = archived.bytes; session.source = { kind: 'bot_reply_image', imageId: session.sourceKey };
        recheck = async () => { await assertAccess(); if (!await this.records.replyMedia(session.scope, session.sourceKey, { metadataOnly: true })) throw new Error('MESSAGE_NOT_RETAINED'); };
      } else {
        const image = await this.images.load(session.scope, session.sourceKey, assertAccess, { signal });
        ({ bytes } = image); session.source = image.source; recheck = image.assertAccess;
      }
    } else {
      recheck = async () => {
        await assertAccess(); session.controller.signal.throwIfAborted();
        const row = await this.records.attachmentDetail(session.scope, session.sourceKey);
        if (!row) throw new Error('ATTACHMENT_NOT_RETAINED');
        await assertAccess(row);
        if (row.attachment.type !== 'video') throw new Error('ATTACHMENT_TYPE_MISMATCH');
        return row;
      };
      const row = await recheck(), pointer = await this.records.attachment(session.scope, session.sourceKey);
      if (!pointer?.url) throw new Error('MEDIA_URL_NOT_PROVIDED');
      if (row.attachment.size > MAX_VIDEO_BYTES) throw new Error('MEDIA_TOO_LARGE');
      try { bytes = await this.download(pointer.url, MAX_VIDEO_BYTES, { signal }); }
      catch (error) { throw new Error(/^IMAGE_[A-Z_]+$/.test(error.message) ? error.message.replace(/^IMAGE_/, 'MEDIA_') : error.message); }
      if (bytes.length > MAX_VIDEO_BYTES) throw new Error('MEDIA_TOO_LARGE');
      if (mediaFormat(bytes) === 'gif') throw new Error('ATTACHMENT_TYPE_MISMATCH');
      session.source = { kind: 'qq_video', attachmentId: session.sourceKey, messageId: row.messageId, historical: row.historical,
        ...(row.messageId.startsWith('element:') ? { embedded: true, identityVerified: false } : {}) };
    }
    if (session.contextChat) session.source = { kind: 'shared_chat_media', context_chat: session.contextChat, sourceId: session.sourceKey };
    session.guard = async () => { session.controller.signal.throwIfAborted(); await assertAccess(); await recheck(); session.controller.signal.throwIfAborted(); };
    await check(); await session.guard();
    if (session.isImage && mediaFormat(bytes) !== 'gif') throw new Error('MEDIA_GIF_REQUIRED');
    session.decoder = await this.decoder.open(bytes, { signal: session.controller.signal, assertAccess: session.guard });
    await session.guard();
  }
  async closeMedia({ turn_id, media_id }) {
    await this.turn(turn_id);
    const session = this.sessions.get(media_id);
    if (!session) return [contentCodecs.value('json', { ok: true, closed: true, media_id })];
    await this.release(session);
    return [contentCodecs.value('json', { ok: true, closed: true, media_id })];
  }
  async release(session) {
    if (session.closing) return session.closing;
    session.controller.abort();
    session.closing = (async () => {
      await session.open; await Promise.allSettled([...session.queries.values()].map(q => q.task));
      await session.decoder?.close(); this.cacheBytes -= session.cacheBytes; session.cacheBytes = 0;
      session.queries.clear(); this.sessions.delete(session.id);
    })();
    return session.closing;
  }
  async clear(generation = this.generation) {
    if (generation !== this.generation) return;
    await Promise.all([...this.sessions.values()].map(session => this.release(session)));
    if (generation === this.generation) { this.turnId = null; this.subscription = null; }
  }
  async close() { this.closed = true; const subscription = await this.subscription?.catch(() => null); await this.clear(); await subscription?.close(); }
}
