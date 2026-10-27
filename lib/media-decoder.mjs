import { fileAudioStream } from './audio-source.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_IMAGE_BYTES, imageType } from './image-policy.mjs';

export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_QUERY_FRAMES = 64;
export function mediaFormat(bytes) {
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'mov';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska';
  throw new Error('MEDIA_FORMAT_UNSUPPORTED');
}

export function processOutput(command, args, signal, stderr = () => {}) {
  signal?.throwIfAborted();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
  let failure;
  const done = new Promise(resolve => {
    child.on('error', error => { failure = error; });
    child.on('close', code => resolve(code));
  });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.stderr.on('data', stderr);
  return { output: child.stdout, done, async check() {
    const code = await done; signal?.throwIfAborted();
    if (failure?.code === 'ENOENT') throw new Error('MEDIA_DECODER_UNAVAILABLE');
    if (failure || code !== 0) throw new Error('MEDIA_DECODE_FAILED');
  }, async close() { signal?.removeEventListener('abort', abort); abort(); await done; } };
}
export async function runMediaProcess(command, args, { signal, maxBytes }) {
  const process = processOutput(command, args, signal); const chunks = []; let size = 0;
  try {
    for await (const chunk of process.output) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > maxBytes) throw new Error('MEDIA_OUTPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    await process.check(); return Buffer.concat(chunks);
  } finally { await process.close(); }
}

// Normalize once: equivalent explicit selections share the same cached query.
export function mediaSelection({ timestamps, start, end, interval } = {}) {
  if (timestamps !== undefined) {
    if (start !== undefined || end !== undefined || interval !== undefined || !Array.isArray(timestamps)
      || timestamps.length > MAX_QUERY_FRAMES || timestamps.some(t => !Number.isFinite(t) || t < 0)) throw new Error('MEDIA_SELECTION_INVALID');
    return { timestamps: [...new Set(timestamps)].sort((a, b) => a - b) };
  }
  if (start === undefined && end === undefined && interval === undefined) return { timestamps: [] };
  if (![start, end, interval].every(Number.isFinite) || start < 0 || end <= start || interval <= 0) throw new Error('MEDIA_SELECTION_INVALID');
  if (Math.ceil((end - start) / interval) > MAX_QUERY_FRAMES) throw new Error('MEDIA_QUERY_TOO_LARGE');
  return { start, end, interval };
}

// PNG is self-framing; retain at most one bounded frame plus one pipe chunk.
export async function* pngFrames(source) {
  let buffer = Buffer.alloc(0), offset = 8;
  for await (const chunk of source) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      if (!buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('MEDIA_FRAME_INVALID');
      if (buffer.length < offset + 8) break;
      const length = buffer.readUInt32BE(offset), next = offset + 12 + length;
      if (next > MAX_IMAGE_BYTES) throw new Error('MEDIA_OUTPUT_TOO_LARGE');
      if (buffer.length < next) break;
      const end = buffer.toString('ascii', offset + 4, offset + 8) === 'IEND'; offset = next;
      if (end) { yield Buffer.from(buffer.subarray(0, offset)); buffer = buffer.subarray(offset); offset = 8; }
    }
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('MEDIA_OUTPUT_TOO_LARGE');
  }
  if (buffer.length) throw new Error('MEDIA_FRAME_INVALID');
}

// Acquisition/authentication stay with callers. One opened file serves all reads.
export class MediaDecoder {
  constructor({ run = runMediaProcess, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', fileSource = fileAudioStream } = {}) { Object.assign(this, { run, ffmpeg, ffprobe, fileSource }); }
  async open(bytes, { signal, assertAccess = async () => {} } = {}) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('MEDIA_INPUT_INVALID');
    const format = mediaFormat(bytes);
    if (bytes.length > (format === 'gif' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) throw new Error('MEDIA_TOO_LARGE');
    const directory = await mkdtemp(join(tmpdir(), 'watch-media-'));
    const controller = new AbortController();
    const lifetime = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const check = async () => { lifetime.throwIfAborted(); await assertAccess(); lifetime.throwIfAborted(); };
    const close = async () => { controller.abort(); await rm(directory, { recursive: true, force: true }); };
    try {
      await check(); const file = join(directory, 'input');
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      const input = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', format, '-f', format,
        ...(format === 'gif' ? ['-ignore_loop', '1'] : format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []), '-i', file];
      const probeSignal = AbortSignal.any([lifetime, AbortSignal.timeout(45000)]);
      const probe = await this.run(this.ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...input,
        '-show_entries', 'format=duration,start_time:stream=index,codec_type,width,height,duration,nb_frames,start_time', '-of', 'json'],
      { signal: probeSignal, maxBytes: 65536 }).catch(error => {
        if (probeSignal.aborted) throw new Error(lifetime.aborted ? 'MEDIA_ABORTED' : 'MEDIA_TIMEOUT');
        throw error;
      });
      await check(); let parsed;
      try { parsed = JSON.parse(probe.toString('utf8')); } catch { throw new Error('MEDIA_METADATA_INVALID'); }
      const video = parsed.streams?.find(stream => stream.codec_type === 'video');
      if (!video) throw new Error('MEDIA_VIDEO_STREAM_MISSING');
      const duration = Number(video.duration ?? parsed.format?.duration), { width, height } = video;
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width <= 0 || height <= 0) throw new Error('MEDIA_METADATA_INVALID');
      if (duration > (format === 'gif' ? 120 : 900) || width > 8192 || height > 8192 || width * height > 16777216) throw new Error('MEDIA_DECODE_LIMIT');
      const metadata = { format, durationSeconds: duration, width, height,
        frameCount: Number.isSafeInteger(Number(video.nb_frames)) && Number(video.nb_frames) > 0 ? Number(video.nb_frames) : null,
        hasAudio: parsed.streams.some(stream => stream.codec_type === 'audio'),
        limitation: 'Selected visual frames only. Audio requires an explicit audio-track query. Frame timestamps are actual decoded presentation times.' };
      const origin = Number(video.start_time ?? parsed.format?.start_time ?? 0);
      const containerOrigin = Number(parsed.format?.start_time ?? 0);
      return { metadata, stream: selection => this.frames(input, selection, duration, lifetime, check),
        audio: ({ start, end }, { signal: audioSignal } = {}) => {
          if (!metadata.hasAudio || format === 'gif') throw new Error('MEDIA_AUDIO_STREAM_MISSING');
          if (!Number.isFinite(origin) || !Number.isFinite(containerOrigin) || origin < containerOrigin) throw new Error('MEDIA_AUDIO_TIMELINE_INVALID');
          return this.fileSource(file, { startSeconds: start + origin - containerOrigin, durationSeconds: end - start,
            ffmpeg: this.ffmpeg, inputFormat: format, preserveTimeline: true,
            signal: AbortSignal.any([lifetime, ...(audioSignal ? [audioSignal] : [])]) });
        }, close };
    } catch (error) { await close(); throw error; }
  }
  async *frames(input, selection, duration, lifetime, check) {
    selection = mediaSelection(selection);
    if (selection.timestamps?.some(t => t >= duration) || selection.end > duration) throw new Error('MEDIA_TIMESTAMP_OUT_OF_RANGE');
    if (selection.timestamps?.length === 0) return;
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(45000)]);
    const predicate = selection.timestamps
      ? selection.timestamps.map(t => `gte(t,${t})*if(isnan(prev_selected_t),1,lt(prev_selected_t,${t}))`).join('+')
      : `gte(t,${selection.start})*lt(t,${selection.end})*if(isnan(prev_selected_t),1,gte(t-prev_selected_t,${selection.interval}))`;
    const stop = selection.timestamps ? selection.timestamps.at(-1) + 1 : selection.end;
    const times = []; let line = '', count = 0, parseError, wakeTimestamp;
    const timestampReady = () => new Promise(resolve => { wakeTimestamp = resolve; });
    const process = processOutput(this.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-max_alloc', '67108864',
      '-threads', '1', '-filter_threads', '1', '-t', String(stop), ...input, '-map', '0:v:0', '-t', String(stop), '-an', '-sn', '-dn',
      '-vf', `setpts=PTS-STARTPTS,select='${predicate}',scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,showinfo`,
      '-fps_mode', 'vfr', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], signal, chunk => {
      line += chunk.toString('utf8');
      const lines = line.split('\n'); line = lines.pop().slice(-8192);
      for (const text of lines) {
        const match = /showinfo[^\]]*\].*\bn:\s*\d+.*\bpts_time:([\d.eE+-]+)/.exec(text);
        if (match) { if (times.length >= MAX_QUERY_FRAMES) parseError = new Error('MEDIA_QUERY_TOO_LARGE'); else times.push(Number(match[1])); wakeTimestamp?.(); }
      }
    });
    try {
      for await (const png of pngFrames(process.output)) {
        await check(); signal.throwIfAborted(); if (parseError) throw parseError;
        // stderr and stdout are independent OS pipes. Flush stderr before pairing.
        if (!times.length) await Promise.race([timestampReady(), process.done]);
        const timestamp = times.shift();
        if (!Number.isFinite(timestamp) || ++count > MAX_QUERY_FRAMES || imageType(png) !== 'image/png') throw new Error('MEDIA_FRAME_INVALID');
        yield { timestamp, bytes: png, mimeType: 'image/png' };
      }
      await process.check(); await check();
      if (parseError) throw parseError;
    } catch (error) { if (signal.aborted) throw new Error(lifetime.aborted ? 'MEDIA_ABORTED' : 'MEDIA_TIMEOUT'); throw error; }
    finally { await process.close(); }
  }
}
