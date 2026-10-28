import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './audio-codecs.mjs';

export const AUDIO_SAMPLE_RATE = 16000;
const runtimeDir = fileURLToPath(new URL('../audio-runtime/', import.meta.url));

// Own one instance at the application boundary and close it when done. Scheduling
// and scoped access belong to callers; overlapping input streams fail explicitly.
export class AudioDecoder {
  #child;
  #children = new Map();
  #pending;
  #busy = false;
  #id = 0;
  constructor({ modelDir, vadModel, runtime = runtimeDir, numThreads = 2, maxSpeechSeconds = 20,
    silenceSeconds = 0.5, paddingSeconds = 0.15, timeoutMs = 300000 } = {}) {
    if (!modelDir || !vadModel) throw new Error('AUDIO_MODEL_REQUIRED');
    if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > 8 ||
      !Number.isFinite(maxSpeechSeconds) || maxSpeechSeconds < 1 || maxSpeechSeconds > 30 ||
      !Number.isFinite(silenceSeconds) || silenceSeconds < 0.2 || silenceSeconds > 2 ||
      !Number.isFinite(paddingSeconds) || paddingSeconds < 0 || paddingSeconds > silenceSeconds ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) {
      throw new Error('AUDIO_CONFIG_INVALID');
    }
    this.config = Object.freeze({ modelDir: resolve(modelDir), vadModel: resolve(vadModel), runtime: resolve(runtime),
      numThreads, maxSpeechSeconds, silenceSeconds, paddingSeconds });
    this.timeoutMs = timeoutMs;
  }
  #request(op, data, signal) {
    signal?.throwIfAborted();
    if (this.#pending) throw new Error('AUDIO_DECODER_BUSY');
    if (!this.#child) {
      // A separate process isolates native faults and permits cancellation during
      // synchronous native inference. Do not forward native stderr or credentials.
      const child = fork(new URL('./audio-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', execArgv: [],
        env: { PATH: process.env.PATH ?? '', OMP_NUM_THREADS: String(this.config.numThreads) },
      });
      this.#child = child;
      this.#children.set(child, new Promise(resolve => child.once('close', () => {
        this.#children.delete(child); resolve();
      })));
      child.on('message', result => {
        if (child !== this.#child || result.id !== this.#pending?.id) return;
        if (result.error) this.#pending.reject(new Error(result.error));
        else this.#pending.resolve(result.value);
      });
      const failed = () => {
        if (child !== this.#child) return;
        this.close(new Error('AUDIO_WORKER_FAILED'));
      };
      child.on('error', failed);
      child.on('exit', failed);
    }
    return new Promise((resolveResult, rejectResult) => {
      const id = ++this.#id;
      const abort = () => this.close(new Error('AUDIO_ABORTED'));
      const timer = setTimeout(() => this.close(new Error('AUDIO_TIMEOUT')), this.timeoutMs);
      const settle = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.#pending = undefined;
        fn(value);
      };
      this.#pending = { id, resolve: value => settle(resolveResult, value), reject: error => settle(rejectResult, error) };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.#child.send({ id, op, data, config: this.config }, error => {
          if (error && this.#pending?.id === id) this.close(new Error('AUDIO_WORKER_FAILED'));
        });
      } catch { this.close(new Error('AUDIO_WORKER_FAILED')); }
      if (signal?.aborted) abort();
    });
  }
  // pcm must be audio.pcm: contiguous mono Float32Array blocks at 16 kHz.
  // Each flow starts a fresh VAD timeline; offsetSeconds maps a selected window
  // back to the original media. Provenance/permission metadata stays with callers.
  decode(pcm, { signal, offsetSeconds = 0, maxSeconds = 600 } = {}) {
    if (pcm?.type !== 'audio.pcm' || !Number.isFinite(offsetSeconds) || offsetSeconds < 0 ||
      !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 3600) throw new Error('AUDIO_INPUT_INVALID');
    const decoder = this;
    const speech = pcm.through('audio.speech', async function* (input) {
      if (decoder.#busy) throw new Error('AUDIO_DECODER_BUSY');
      decoder.#busy = true;
      let completed = false;
      let count = 0;
      const abort = () => decoder.close(new Error('AUDIO_ABORTED'));
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        await decoder.#request('start', undefined, signal);
        for await (const block of input) {
          signal?.throwIfAborted();
          if (block?.sampleRate !== AUDIO_SAMPLE_RATE || !(block.samples instanceof Float32Array) ||
            block.samples.length > AUDIO_SAMPLE_RATE * 10 ||
            block.samples.some(value => !Number.isFinite(value) || Math.abs(value) > 1)) throw new Error('AUDIO_PCM_INVALID');
          count += block.samples.length;
          if (count > Math.floor(maxSeconds * AUDIO_SAMPLE_RATE)) throw new Error('AUDIO_DURATION_LIMIT');
          // At most one second per native request; no whole-recording buffering.
          for (let i = 0; i < block.samples.length; i += AUDIO_SAMPLE_RATE) {
            const segments = await decoder.#request('push', block.samples.slice(i, i + AUDIO_SAMPLE_RATE), signal);
            for (const segment of segments) yield { ...segment,
              start_seconds: offsetSeconds + segment.start_seconds, end_seconds: offsetSeconds + segment.end_seconds };
          }
        }
        for (const segment of await decoder.#request('flush', undefined, signal)) yield { ...segment,
          start_seconds: offsetSeconds + segment.start_seconds, end_seconds: offsetSeconds + segment.end_seconds };
        completed = true;
      } finally {
        signal?.removeEventListener('abort', abort);
        // Failed conversions and early consumer exits also discard pending VAD.
        if (!completed) decoder.close();
        decoder.#busy = false;
      }
    });
    return speech.to('audio.transcript', { decoder, signal });
  }
  async transcribe(samples, signal) {
    if (!(samples instanceof Float32Array) || !samples.length ||
      samples.length > Math.ceil((this.config.maxSpeechSeconds + 2 * this.config.paddingSeconds + 1) * AUDIO_SAMPLE_RATE)) {
      throw new Error('AUDIO_SPEECH_INVALID');
    }
    return this.#request('transcribe', samples, signal);
  }
  close(error = new Error('AUDIO_DECODER_CLOSED')) {
    this.#child = undefined;
    this.#pending?.reject(error);
    const exits = [...this.#children.values()];
    for (const child of this.#children.keys()) child.kill('SIGKILL');
    return Promise.all(exits);
  }
}
