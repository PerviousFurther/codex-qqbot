import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { contentCodecs } from './content-codecs.mjs';

// Acquisition adapter, separate from VAD/ASR. Accept only an already authorized
// local file; ffmpeg never receives a URL or permission to use network protocols.
export function fileAudioStream(file, { startSeconds = 0, durationSeconds = 600,
  ffmpeg = 'ffmpeg', signal, inputFormat, preserveTimeline = false } = {}) {
  if (typeof file !== 'string' || !file || !Number.isFinite(startSeconds) || startSeconds < 0 ||
    !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 3600) throw new Error('AUDIO_INPUT_INVALID');
  if (inputFormat !== undefined && !['mov', 'matroska'].includes(inputFormat)) throw new Error('AUDIO_INPUT_INVALID');
  const path = resolve(file);
  return contentCodecs.stream('audio.pcm', (async function* () {
    signal?.throwIfAborted();
    if (!(await stat(path)).isFile()) throw new Error('AUDIO_FILE_REQUIRED');
    signal?.throwIfAborted();
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1',
      '-protocol_whitelist', 'file,pipe',
      ...(inputFormat ? ['-format_whitelist', inputFormat, '-f', inputFormat] : []),
      ...(inputFormat === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
      '-ss', String(startSeconds), '-i', path,
      '-t', String(durationSeconds), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000',
      ...(preserveTimeline ? ['-af', 'aresample=16000:async=1:first_pts=0'] : []),
      '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '' } });
    let spawnError;
    const done = new Promise(resolveDone => {
      child.on('error', error => { spawnError = error; });
      child.on('close', code => resolveDone(code));
    });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const bytesPerBlock = 16000 * 4;
    let pending = Buffer.alloc(0);
    let bytes = 0;
    const packet = buffer => {
      const samples = new Float32Array(buffer.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readFloatLE(i * 4);
      return { sampleRate: 16000, samples };
    };
    try {
      for await (const data of child.stdout) {
        signal?.throwIfAborted();
        bytes += data.length;
        if (bytes > Math.ceil(durationSeconds * 16000) * 4) throw new Error('AUDIO_DURATION_LIMIT');
        pending = Buffer.concat([pending, data]);
        while (pending.length >= bytesPerBlock) {
          yield packet(pending.subarray(0, bytesPerBlock));
          pending = pending.subarray(bytesPerBlock);
        }
      }
      const code = await done;
      signal?.throwIfAborted();
      if (spawnError?.code === 'ENOENT') throw new Error('AUDIO_FFMPEG_UNAVAILABLE');
      if (spawnError || code !== 0) throw new Error('AUDIO_EXTRACTION_FAILED');
      if (pending.length % 4) throw new Error('AUDIO_PCM_INVALID');
      if (pending.length) yield packet(pending);
    } finally {
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      await done;
    }
  })());
}

// QQ SILK voice is not handled by ffmpeg. Decode the bounded short attachment
// in an isolated WASM process, then expose the same normalized PCM contract.
export function silkAudioStream(bytes, { runtime = fileURLToPath(new URL('../audio-runtime/', import.meta.url)),
  maxSeconds = 120, signal } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024 ||
    !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 120) throw new Error('AUDIO_INPUT_INVALID');
  return contentCodecs.stream('audio.pcm', (async function* () {
    signal?.throwIfAborted();
    const child = fork(new URL('./audio-silk-worker.mjs', import.meta.url), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', execArgv: [], env: {},
    });
    let abort, timer;
    try {
      const samples = await new Promise((accept, reject) => {
        abort = () => reject(new Error('AUDIO_ABORTED'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('AUDIO_TIMEOUT')), 15000);
        child.once('message', result => {
          if (result.error) reject(new Error(result.error));
          else accept(result.samples);
        });
        child.once('error', () => reject(new Error('AUDIO_WORKER_FAILED')));
        child.once('exit', () => reject(new Error('AUDIO_WORKER_FAILED')));
        child.send({ bytes, runtime: resolve(runtime), maxSeconds }, error => {
          if (error) reject(new Error('AUDIO_WORKER_FAILED'));
        });
        if (signal?.aborted) abort();
      });
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (!(samples instanceof Float32Array) || samples.length > maxSeconds * 16000) throw new Error('AUDIO_DURATION_LIMIT');
      for (let i = 0; i < samples.length; i += 16000) {
        signal?.throwIfAborted();
        yield { sampleRate: 16000, samples: samples.subarray(i, i + 16000) };
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
    }
  })());
}
