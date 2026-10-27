// Shared byte signatures for received audio and outgoing audio attachments.
export function audioType(bytes) {
  const head = bytes.subarray(0, 16).toString('ascii');
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (head.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224) return 'audio/mpeg';
  if (head.slice(4, 8) === 'ftyp') return 'audio/mp4';
  if (head.startsWith('OggS')) return 'audio/ogg';
  if (head.startsWith('fLaC')) return 'audio/flac';
  if (head.startsWith('#!AMR')) return 'audio/amr';
  if (head.startsWith('#!SILK_V3') || head.slice(1).startsWith('#!SILK_V3')) return 'audio/silk';
  throw new Error('AUDIO_FORMAT_UNSUPPORTED');
}
