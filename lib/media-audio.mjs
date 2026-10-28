import { AudioDecoder } from './audio-decoder.mjs';
import { acquireAudioSlot } from './audio-slot.mjs';

const MAX_MEDIA_AUDIO_SECONDS = 120;
const paddingSeconds = 0.25;
export function audioSelection({ start, end, timestamps, interval }) {
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || timestamps !== undefined || interval !== undefined) throw new Error('MEDIA_SELECTION_INVALID');
  if (end - start > MAX_MEDIA_AUDIO_SECONDS) throw new Error('AUDIO_DURATION_LIMIT');
  return { start, end };
}

// Speech-only side branch over the already opened, authorized video file.
// Scheduling/auth/cache belong to MessageMedia; source/VAD/ASR stay reusable.
export class MediaAudio {
  constructor({ config = {}, store, slot = acquireAudioSlot, createDecoder = options => new AudioDecoder(options) }) {
    Object.assign(this, { config, store, slot, createDecoder });
  }
  async *stream(media, selection, { signal, assertAccess }) {
    if (!media.metadata.hasAudio) throw new Error('MEDIA_AUDIO_STREAM_MISSING');
    if (selection.end > media.metadata.durationSeconds) throw new Error('MEDIA_TIMESTAMP_OUT_OF_RANGE');
    if (!this.config.modelDir || !this.config.vadModel) throw new Error('AUDIO_LOCAL_NOT_CONFIGURED');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(100000)]);
    const check = async () => { combined.throwIfAborted(); await assertAccess(); combined.throwIfAborted(); };
    let decoder, release;
    try {
      await check(); release = await this.slot(this.store); await check();
      decoder = this.createDecoder({ ...this.config, timeoutMs: 100000 });
      const start = Math.max(0, selection.start - paddingSeconds), end = Math.min(media.metadata.durationSeconds, selection.end + paddingSeconds);
      const pcm = media.audio({ start, end }, { signal: combined }).through('audio.pcm', async function* (input) {
        for await (const packet of input) { await check(); yield packet; }
      });
      const seen = new Set(); let count = 0, characters = 0;
      for await (const segment of decoder.decode(pcm, { signal: combined, offsetSeconds: start, maxSeconds: end - start + 1 / 16000 })) {
        await check();
        if (typeof segment.text !== 'string' || !Number.isFinite(segment.start_seconds) || !Number.isFinite(segment.end_seconds)
          || segment.start_seconds < start || segment.end_seconds < segment.start_seconds || segment.end_seconds > end + 0.1) throw new Error('AUDIO_TRANSCRIPT_INVALID');
        if (segment.end_seconds <= selection.start || segment.start_seconds >= selection.end) continue;
        if (!segment.text.trim()) continue;
        const key = JSON.stringify([segment.start_seconds, segment.end_seconds, segment.text]);
        if (seen.has(key)) continue;
        seen.add(key); characters += segment.text.length;
        if (++count > 100 || characters > 12000) throw new Error('AUDIO_TRANSCRIPT_TOO_LARGE');
        // Preserve VAD boundaries; no invented word timings or text truncation.
        yield { ...segment, source: 'local_asr', untrusted: true,
          contextOverlap: segment.start_seconds < selection.start || segment.end_seconds > selection.end };
      }
      await check();
    } catch (error) {
      if (combined.aborted) throw new Error(signal.aborted ? 'AUDIO_ABORTED' : 'AUDIO_TIMEOUT');
      throw error;
    } finally { try { await decoder?.close(); } finally { release?.(); } }
  }
}
