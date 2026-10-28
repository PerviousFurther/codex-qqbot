import { open } from 'node:fs/promises';
import { mediaFormat } from './media-decoder.mjs';
import { audioType } from './audio-policy.mjs';
import { processOutput, runMediaProcess } from './media-decoder.mjs';

const MAX_GIF_SECONDS = 15;
async function mediaInput(path) {
  const file = await open(path, 'r'); const head = Buffer.alloc(64);
  try { await file.read(head, 0, 64, 0); } finally { await file.close(); }
  let format;
  try { format = mediaFormat(head); }
  catch { format = ({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/amr': 'amr' })[audioType(head)]; }
  if (!format) throw new Error('FILE_ENCODING_SOURCE_UNSUPPORTED');
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', format, '-f', format,
    ...(format === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : format === 'gif' ? ['-ignore_loop', '1'] : []), '-i', path];
}

// Whole-source conversion only. No seek/crop/duration arguments are exposed.
export class FileMediaEncoder {
  constructor({ run = runMediaProcess, stream = processOutput, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) { Object.assign(this, { run, stream, ffmpeg, ffprobe }); }
  async encode(path, { format, bitrate_kbps, fps = 10, width = 480, signal }) {
    const lifetime = AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
    const input = await mediaInput(path);
    const raw = await this.run(this.ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...input, '-show_entries', 'format=duration:stream=codec_type,duration,width,height,bit_rate', '-of', 'json'], { signal: lifetime, maxBytes: 65536 });
    let metadata;
    try { metadata = JSON.parse(raw.toString()); } catch { throw new Error('FILE_MEDIA_METADATA_INVALID'); }
    const videos = metadata.streams?.filter(stream => stream.codec_type === 'video') ?? [];
    const durations = [metadata.format?.duration, ...videos.map(stream => stream.duration)].map(Number).filter(value => Number.isFinite(value) && value > 0);
    if (!durations.length) throw new Error('FILE_MEDIA_DURATION_UNKNOWN');
    const duration = Math.max(...durations);
    if (duration > 900) throw new Error('FILE_MEDIA_DURATION_LIMIT');
    if (videos.some(video => !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width < 1 || video.height < 1 || video.width > 8192 || video.height > 8192 || video.width * video.height > 16777216)) throw new Error('FILE_MEDIA_DIMENSION_LIMIT');
    if (format === 'gif' && duration > MAX_GIF_SECONDS) throw new Error('FILE_GIF_DURATION_LIMIT');
    if (format !== 'audio' && !videos.length) throw new Error('FILE_VIDEO_STREAM_MISSING');
    if (format === 'audio' && !metadata.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('FILE_AUDIO_STREAM_MISSING');
    const sourceKbps = Number(videos[0]?.bit_rate) / 1000;
    const videoBitrate = bitrate_kbps ?? (Number.isFinite(sourceKbps) && sourceKbps > 0 ? Math.max(1, Math.min(1200, Math.floor(sourceKbps))) : 1200);
    const output = format === 'gif'
      ? ['-map', '0:v:0', '-an', '-vf', `fps=${fps},scale=w='min(${width},iw)':h=-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, '-loop', '0', '-f', 'gif']
      : format === 'audio' ? ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate_kbps ?? 128}k`, '-f', 'mp3']
        : ['-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${videoBitrate}k`, '-c:a', 'aac', '-b:a', '96k', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4'];
    const create = this.stream, ffmpeg = this.ffmpeg;
    return { duration, stream: (async function* () {
      const process = create(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-max_alloc', '67108864', ...input, ...output, '-threads', '1', 'pipe:1'], lifetime);
      try { for await (const chunk of process.output) { lifetime.throwIfAborted(); yield chunk; } await process.check(); }
      finally { await process.close(); }
    })() };
  }
}
