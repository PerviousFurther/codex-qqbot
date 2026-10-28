import { randomUUID } from 'node:crypto';
import { MAX_IMAGE_BYTES } from './image-policy.mjs';

// Only fixed DOM/media operations execute in the page; arguments never contain code.
export function describeWebMedia(element) {
  const ranges = source => Array.from({ length: source.length }, (_, i) => ({ start: source.start(i), end: source.end(i) }));
  return { kind: element.tagName.toLowerCase(), duration: Number.isFinite(element.duration) ? element.duration : null,
    live: element.duration === Infinity, current_time: element.currentTime, paused: element.paused,
    ready_state: element.readyState, error: element.error ? 'WEB_MEDIA_PLAYBACK_ERROR' : null,
    encrypted: !!element.mediaKeys, seekable: ranges(element.seekable), buffered: ranges(element.buffered),
    width: element.videoWidth ?? null, height: element.videoHeight ?? null,
    tracks: Array.from(element.textTracks ?? [], (track, index) => ({ index, kind: track.kind,
      language: track.language.slice(0, 80), label: track.label.slice(0, 200), mode: track.mode })) };
}

export function seekWebMedia(element, seconds) {
  return new Promise((accept, reject) => {
    if (element.mediaKeys) return reject(new Error('WEB_MEDIA_ENCRYPTED'));
    if (element.error) return reject(new Error('WEB_MEDIA_PLAYBACK_ERROR'));
    const inside = Array.from({ length: element.seekable.length }, (_, i) =>
      seconds >= element.seekable.start(i) && seconds < element.seekable.end(i)).some(Boolean);
    if (!inside) return reject(new Error('WEB_MEDIA_OUTSIDE_SEEKABLE_RANGE'));
    const video = element.tagName.toLowerCase() === 'video';
    if (video && typeof element.requestVideoFrameCallback !== 'function') return reject(new Error('WEB_MEDIA_FRAME_CALLBACK_UNSUPPORTED'));
    let callback, timer;
    const finish = (error, time) => {
      clearTimeout(timer); element.removeEventListener('seeked', seeked); element.removeEventListener('error', failed);
      if (callback !== undefined) element.cancelVideoFrameCallback(callback);
      element.pause();
      error ? reject(new Error(error)) : accept(time);
    };
    const failed = () => finish('WEB_MEDIA_PLAYBACK_ERROR');
    const presented = () => {
      if (!video) return finish(null, element.currentTime);
      callback = element.requestVideoFrameCallback((_, frame) => finish(
        Math.abs(frame.mediaTime - seconds) > 0.3 ? 'WEB_MEDIA_TIMESTAMP_MISMATCH' : null, frame.mediaTime));
      // Some players need playback to present a decoded frame after seeking.
      element.muted = true; element.play().catch(() => {});
    };
    const seeked = () => presented();
    timer = setTimeout(() => finish('WEB_MEDIA_SEEK_TIMEOUT'), 15000);
    element.addEventListener('error', failed, { once: true });
    try {
      if (Math.abs(element.currentTime - seconds) < 0.01 && element.readyState >= 2) presented();
      else { element.addEventListener('seeked', seeked, { once: true }); element.currentTime = seconds; }
    } catch { finish('WEB_MEDIA_SEEK_FAILED'); }
  });
}

export function readWebTextTrack(element, { track_index, start, end }) {
  const track = element.textTracks?.[track_index];
  if (!track) throw new Error('WEB_MEDIA_TRACK_NOT_FOUND');
  if (track.mode === 'disabled') track.mode = 'hidden';
  const cues = []; let characters = 0; let truncated = false;
  for (const cue of Array.from(track.cues ?? [])) {
    if (cue.endTime <= start || cue.startTime >= end) continue;
    const text = String(cue.text ?? '').slice(0, 3000);
    if (cues.length >= 100 || characters + text.length > 12000) { truncated = true; break; }
    cues.push({ start: cue.startTime, end: cue.endTime, text }); characters += text.length;
  }
  return { status: track.cues === null ? 'NOT_LOADED' : cues.length ? 'AVAILABLE' : 'NO_CUES_IN_WINDOW',
    language: track.language.slice(0, 80), cues, truncated };
}

// Decode only codes emitted by our fixed page functions, never arbitrary page text.
const pageErrorCodes = new Set([
  'WEB_MEDIA_ENCRYPTED', 'WEB_MEDIA_PLAYBACK_ERROR', 'WEB_MEDIA_OUTSIDE_SEEKABLE_RANGE',
  'WEB_MEDIA_FRAME_CALLBACK_UNSUPPORTED', 'WEB_MEDIA_TIMESTAMP_MISMATCH',
  'WEB_MEDIA_SEEK_TIMEOUT', 'WEB_MEDIA_SEEK_FAILED', 'WEB_MEDIA_TRACK_NOT_FOUND',
]);
async function evaluateMedia(handle, operation, argument) {
  try { return await handle.evaluate(operation, argument); }
  catch (error) {
    const firstLine = String(error.message ?? '').split('\n', 1)[0];
    const code = firstLine.replace(/^elementHandle\.evaluate: (?:Error: )?/, '');
    throw new Error(pageErrorCodes.has(code) ? code
      : error.name === 'TimeoutError' ? 'WEB_MEDIA_EVALUATION_TIMEOUT' : 'WEB_MEDIA_EVALUATION_FAILED');
  }
}

// References cover actual video/audio elements, including checked child frames.
// Navigation and explicit rediscovery dispose references rather than guessing replacements.
export class WebPlayers {
  constructor(page) {
    this.page = page; this.handles = new Map(); this.generation = 0; this.pending = new Set();
    this.navigation = () => { void this.clear(); };
    page.on('framenavigated', this.navigation);
  }
  async clear() {
    this.generation++;
    const handles = [...this.handles.values()]; this.handles.clear();
    const task = Promise.allSettled(handles.map(handle => handle.dispose()));
    this.pending.add(task);
    try { await task; } finally { this.pending.delete(task); }
  }
  async list() {
    await this.clear(); const generation = this.generation; const media = [];
    try {
      for (const frame of this.page.frames()) {
        for (const handle of await frame.$$('video,audio')) {
          if (generation !== this.generation) { await handle.dispose(); throw new Error('WEB_MEDIA_STALE'); }
          const media_id = randomUUID(); this.handles.set(media_id, handle);
          media.push({ media_id, ...await evaluateMedia(handle, describeWebMedia) });
        }
      }
      if (generation !== this.generation) throw new Error('WEB_MEDIA_STALE');
      return { media, untrusted: true, limitation: 'Only HTML video/audio players are discoverable. Canvas-only, DRM and unsupported codecs may be unavailable. IDs expire on navigation, rediscovery or page closure.' };
    } catch (error) { await this.clear(); throw error; }
  }
  async resolve(id) {
    const handle = this.handles.get(id);
    if (!handle || !await handle.evaluate(node => node.isConnected).catch(() => false)
      || this.handles.get(id) !== handle) throw new Error('WEB_MEDIA_STALE');
    return handle;
  }
  async read({ media_id, seconds, capture = true }) {
    const handle = await this.resolve(media_id);
    const initial = await evaluateMedia(handle, describeWebMedia);
    if (initial.encrypted) throw new Error('WEB_MEDIA_ENCRYPTED');
    const actual = seconds === undefined ? initial.current_time : await evaluateMedia(handle, seekWebMedia, seconds);
    await this.resolve(media_id);
    const metadata = await evaluateMedia(handle, describeWebMedia);
    if (!capture) return { media_id, ...metadata, seconds: actual, untrusted: true };
    if (metadata.kind !== 'video') throw new Error('WEB_MEDIA_VIDEO_REQUIRED');
    if (metadata.ready_state < 2) throw new Error('WEB_MEDIA_FRAME_NOT_READY');
    let image;
    try { image = await handle.screenshot({ type: 'jpeg', quality: 75, timeout: 10000 }); }
    catch (error) { throw new Error(error.name === 'TimeoutError' ? 'WEB_MEDIA_SCREENSHOT_TIMEOUT' : 'WEB_MEDIA_SCREENSHOT_FAILED'); }
    if (image.length > MAX_IMAGE_BYTES) throw new Error('WEB_SCREENSHOT_TOO_LARGE');
    await this.resolve(media_id);
    return { media_id, ...metadata, seconds: actual, image, capture: 'video_element', untrusted: true };
  }
  async subtitles({ media_id, track_index = 0, start = 0, end = 120 }) {
    if (!(end > start) || end - start > 120) throw new Error('WEB_MEDIA_SUBTITLE_RANGE_INVALID');
    const handle = await this.resolve(media_id);
    const result = await evaluateMedia(handle, readWebTextTrack, { track_index, start, end });
    await this.resolve(media_id);
    return { media_id, track_index, start, end, ...result, untrusted: true,
      limitation: 'Only browser-exposed text-track cues, not custom subtitle overlays, canvas text or complete site transcripts. NOT_LOADED can be checked after the page loads the selected track.' };
  }
  async close() { this.page.off('framenavigated', this.navigation); await this.clear(); await Promise.allSettled([...this.pending]); }
}
