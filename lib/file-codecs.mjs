import { extname } from 'node:path';
import { contentCodecs } from './content-codecs.mjs';
import { imageType } from './image-policy.mjs';
import { audioType } from './audio-policy.mjs';

const text = new Set('txt md markdown json jsonl csv tsv log yaml yml toml ini xml html htm css js mjs cjs ts tsx jsx py sh sql rs c cc cpp h hpp java go rb rst adoc svg srt vtt'.split(' '));
const images = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const videos = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' };
const audios = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', amr: 'audio/amr', silk: 'audio/silk' };
export function fileType(name) {
  const extension = extname(name).slice(1).toLowerCase();
  const imageMime = Object.hasOwn(images, extension) ? images[extension] : null;
  const videoMime = Object.hasOwn(videos, extension) ? videos[extension] : null;
  const audioMime = Object.hasOwn(audios, extension) ? audios[extension] : null;
  const kind = !extension || text.has(extension) ? 'text' : imageMime ? 'image' : videoMime ? 'video' : audioMime ? 'audio' : 'binary';
  return { kind, extension, mimeType: imageMime || videoMime || audioMime || (kind === 'text' ? 'text/plain' : 'application/octet-stream'),
    maxBytes: kind === 'text' ? 65536 : kind === 'image' ? 16 * 1024 * 1024 : kind === 'audio' ? 8 * 1024 * 1024 : 64 * 1024 * 1024 };
}
export function validateFileHead(name, bytes) {
  const type = fileType(name);
  let mime;
  if (type.kind === 'image') mime = imageType(bytes);
  if (type.kind === 'audio') mime = audioType(bytes);
  if (type.kind === 'video') {
    if (bytes.toString('ascii', 4, 8) === 'ftyp') mime = ['mp4', 'm4v'].includes(type.extension) ? 'video/mp4' : 'video/quicktime';
    else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) mime = type.extension === 'webm' ? 'video/webm' : 'video/x-matroska';
  }
  if (type.kind !== 'text' && type.kind !== 'binary' && mime !== type.mimeType) throw new Error('FILE_EXTENSION_MISMATCH');
  return type;
}

// Pure encoding/decoding at the file boundary; storage and acquisition own all I/O.
contentCodecs.register('text', 'file.bytes', value => Buffer.from(value, 'utf8'))
  .register('file.bytes', 'text', bytes => {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('FILE_UTF8_REQUIRED'); }
    if (text.includes('\0')) throw new Error('FILE_TEXT_REQUIRED');
    return text;
  })
  .register('file.bytes', 'image', (bytes, context) => ({ bytes, mimeType: imageType(bytes), source: context.source }));

export async function* fileEncoder(name, source, { signal, onComplete = () => {} } = {}) {
  const type = fileType(name); let size = 0; let head = Buffer.alloc(0);
  const decoder = type.kind === 'text' ? new TextDecoder('utf-8', { fatal: true }) : null;
  for await (const value of source) {
    signal?.throwIfAborted(); const chunk = Buffer.from(value); size += chunk.length;
    if (size > type.maxBytes) throw new Error(type.kind === 'image' ? 'IMAGE_TOO_LARGE' : type.kind === 'audio' ? 'AUDIO_TOO_LARGE' : 'FILE_TOO_LARGE');
    if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
    if (decoder) {
      let text;
      try { text = decoder.decode(chunk, { stream: true }); } catch { throw new Error('FILE_UTF8_REQUIRED'); }
      if (text.includes('\0')) throw new Error('FILE_TEXT_REQUIRED');
    }
    yield chunk;
  }
  if (decoder) { try { decoder.decode(); } catch { throw new Error('FILE_UTF8_REQUIRED'); } }
  else if (!size) throw new Error('FILE_EMPTY');
  validateFileHead(name, head);
  signal?.throwIfAborted(); await onComplete(size);
}
