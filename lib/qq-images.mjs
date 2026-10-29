import { MAX_IMAGE_BYTES, imageType } from './image-policy.mjs';

const maxBytes = MAX_IMAGE_BYTES;
const allowedHosts = new Set(['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']);

export function isQQMediaUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname) && !url.username && !url.password && !url.port;
  } catch { return false; }
}

// Received preview text can contain the same private URLs as attachments.
// Keep acquisition pointers in scoped storage, never in model-facing prose/JSON.
export function redactQQMediaUrls(text) {
  return text.replace(/(?:https?:)?\/\/[^\s<>"'`\\]+/gi, value => {
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      return allowedHosts.has(url.hostname) ? '[QQ attachment URL withheld]' : value;
    } catch { return value; }
  });
}

export async function downloadQQImage(url, options = {}) {
  const bytes = await downloadQQMedia(url, maxBytes, options);
  return { bytes, mimeType: imageType(bytes) };
}

export async function downloadQQMedia(url, byteLimit = maxBytes, { signal, consume } = {}) {
  let parsed;
  try { parsed = new URL(url.startsWith('//') ? `https:${url}` : url); } catch { throw new Error('IMAGE_URL_UNSUPPORTED'); }
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('IMAGE_HOST_UNSUPPORTED');
  let response;
  try { response = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]) }); }
  catch { throw new Error('IMAGE_DOWNLOAD_FAILED'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error('IMAGE_UNAVAILABLE_OR_EXPIRED'); }
  if (Number(response.headers.get('content-length')) > byteLimit) { await response.body?.cancel(); throw new Error('IMAGE_TOO_LARGE'); }
  const chunks = async function* () {
    let size = 0;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted(); size += chunk.length;
        if (size > byteLimit) throw new Error('IMAGE_TOO_LARGE');
        yield chunk;
      }
    } catch (error) {
      if (error.message === 'IMAGE_TOO_LARGE' || signal?.aborted) throw error;
      throw new Error('IMAGE_DOWNLOAD_FAILED');
    } finally { await response.body?.cancel().catch(() => {}); }
  };
  if (consume) return consume(chunks());
  const buffered = []; for await (const chunk of chunks()) buffered.push(chunk);
  return Buffer.concat(buffered);
}
