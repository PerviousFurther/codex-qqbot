// Shared limits for ordinary image acquisition, retention and sending.
export const IMAGE_LIMIT_MIB = 16;
export const MAX_IMAGE_BYTES = IMAGE_LIMIT_MIB * 1024 * 1024;

export function imageLimitDetails(error) {
  if (!['IMAGE_TOO_LARGE', 'SAVED_IMAGE_TOO_LARGE', 'WEB_SCREENSHOT_TOO_LARGE'].includes(error.message)) return null;
  return { limit_bytes: MAX_IMAGE_BYTES, limit_mib: IMAGE_LIMIT_MIB,
    recovery: `图片超过 ${IMAGE_LIMIT_MIB} MiB 上限，未能完成本次图片操作。请用普通文字明确告诉用户图片过大、暂时无法查看/保存/发送，并建议压缩图片或降低分辨率后重发；不要声称已看过或已发送，不要重复尝试同一原图。` };
}

export function imageType(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('IMAGE_FORMAT_UNSUPPORTED');
}
