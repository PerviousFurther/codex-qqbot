import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AudioDecoder } from './audio-decoder.mjs';
import { fileAudioStream, silkAudioStream } from './audio-source.mjs';
import { downloadQQMedia } from './qq-images.mjs';
import { audioType } from './audio-policy.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { withAudioSlot } from './audio-slot.mjs';

const maxBytes = 8 * 1024 * 1024;
const maxSeconds = 120;

// Scoped acquisition and access live here, outside reusable media decoders.
export class MessageAudio {
  constructor({ scope, store, records, config = {}, download = downloadQQMedia,
    createDecoder = options => new AudioDecoder(options), fileSource = fileAudioStream,
    silkSource = silkAudioStream, slot = withAudioSlot, assertAccess = row => assertMessageAccess(scope, store, row) }) {
    Object.assign(this, { scope, store, records, config, download, createDecoder, fileSource, silkSource, slot, assertAccess });
    this.jobs = new Set(); this.closed = false;
  }
  async detail(id, method, { signal } = {}) {
    if (!['qq', 'local'].includes(method)) throw new Error('AUDIO_METHOD_INVALID');
    if (this.closed) throw new Error('AUDIO_READER_CLOSED');
    const job = new AbortController();
    let finish;
    const entry = { controller: job, done: new Promise(resolve => { finish = resolve; }) };
    this.jobs.add(entry);
    const combined = AbortSignal.any([job.signal, AbortSignal.timeout(100000), ...(signal ? [signal] : [])]);
    const check = async () => {
      combined.throwIfAborted();
      await this.assertAccess();
      const archived = await this.records.replyMedia?.(this.scope, id, { metadataOnly: true });
      const row = archived ? { messageId: archived.message_id, attachment: { type: archived.kind }, historical: true } : await this.records.attachmentDetail(this.scope, id);
      if (!row) throw new Error('ATTACHMENT_NOT_RETAINED');
      await this.assertAccess(row);
      if (row.attachment.type !== 'audio') throw new Error('ATTACHMENT_TYPE_MISMATCH');
      combined.throwIfAborted();
      return row;
    };
    try {
      const row = await check();
      const base = { attachment_id: id, messageId: row.messageId, method, untrusted: true };
      if (method === 'qq') {
        const transcript = row.attachment.transcript;
        await check();
        return { ...base, status: transcript ? 'AVAILABLE' : 'NOT_PROVIDED', source: 'qq_platform_asr',
          text: transcript?.text ?? '', limitation: 'Platform-provided reference text; not verified by local recognition.' };
      }
      if (!this.config.modelDir || !this.config.vadModel) throw new Error('AUDIO_LOCAL_NOT_CONFIGURED');
      return await this.slot(this.store, async () => {
        let directory, decoder;
        try {
          await check();
          const archived = await this.records.replyMedia?.(this.scope, id);
          const attachment = archived ?? await this.records.attachment(this.scope, id);
          if (!archived && !attachment?.url) throw new Error('AUDIO_URL_NOT_PROVIDED');
          await this.assertAccess(attachment);
          let bytes;
          try { bytes = archived ? archived.bytes : await this.download(attachment.url, maxBytes, { signal: combined }); }
          catch (error) {
            if (/^IMAGE_[A-Z_]+$/.test(error.message)) throw new Error(error.message.replace(/^IMAGE_/, 'AUDIO_'));
            throw error;
          }
          await check();
          if (!bytes?.length) throw new Error('AUDIO_EMPTY');
          if (bytes.length > maxBytes) throw new Error('AUDIO_TOO_LARGE');
          const type = audioType(bytes);
          decoder = this.createDecoder({ ...this.config, timeoutMs: 100000 });
          let source;
          if (type === 'audio/silk') {
            source = this.silkSource(bytes, { runtime: this.config.runtime, maxSeconds, signal: combined });
          } else {
            directory = await mkdtemp(join(tmpdir(), 'watch-audio-'));
            const path = join(directory, 'received-audio');
            await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
            // Probe one second beyond the limit so long attachments fail instead
            // of returning an apparently complete transcript of a truncated file.
            source = this.fileSource(path, { durationSeconds: maxSeconds + 1, signal: combined });
          }
          const guarded = source.through('audio.pcm', async function* (input) {
            for await (const packet of input) { await check(); yield packet; }
          });
          const segments = [];
          let characters = 0;
          for await (const segment of decoder.decode(guarded, { signal: combined, maxSeconds })) {
            await check();
            characters += segment.text.length;
            if (segments.length >= 100 || characters > 12000) throw new Error('AUDIO_TRANSCRIPT_TOO_LARGE');
            segments.push(segment);
          }
          await check();
          return { ...base, source: 'local_asr', status: segments.length ? 'TRANSCRIBED' : 'NO_SPEECH_DETECTED',
            text: segments.map(segment => segment.text).filter(Boolean).join('\n'), segments };
        } finally {
          await decoder?.close();
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      });
    } catch (error) {
      if (combined.aborted) throw new Error(signal?.aborted || job.signal.aborted ? 'AUDIO_ABORTED' : 'AUDIO_TIMEOUT');
      throw error;
    } finally { this.jobs.delete(entry); finish(); }
  }
  async close() {
    this.closed = true;
    const jobs = [...this.jobs];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map(job => job.done));
  }
}
