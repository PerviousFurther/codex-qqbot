import { assertAllowedWebDomain } from './web-access-policy.mjs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
export function validatePublicURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('WEB_URL_INVALID'); }
  if (url.href.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('WEB_URL_NOT_ALLOWED');
  if (url.hostname.includes(':')) throw new Error('WEB_IPV6_UNSUPPORTED');
  url.hash = '';
  return assertAllowedWebDomain(url);
}

async function download(url, signal, types, maxBytes, onBytes, consume) {
  signal.throwIfAborted();
  // Pin the validated address for the actual socket, including every redirect.
  const records = await new Promise((accept, reject) => {
    const abort = () => reject(new Error('WEB_READ_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    lookup(url.hostname, { all: true, family: 4 }).then(accept, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!records.length || records.some(record => !publicIPv4(record.address))) throw new Error('WEB_ADDRESS_NOT_ALLOWED');
  const address = records[0].address;
  return new Promise((accept, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent: false, family: 4,
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
      headers: { 'user-agent': 'WatchVideoReader/1.0', accept: '*/*', 'accept-encoding': 'identity' },
    }, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const redirect = response.headers.location; response.destroy();
        if (!redirect) return reject(new Error('WEB_REDIRECT_INVALID'));
        return accept({ redirect });
      }
      if (status < 200 || status >= 300) { response.destroy(); return reject(new Error(`WEB_HTTP_${status}`)); }
      const type = response.headers['content-type'] ?? '';
      if (!types.test(type)) {
        response.destroy(); return reject(new Error('WEB_CONTENT_TYPE_UNSUPPORTED'));
      }
      const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
        : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (!decoder && encoding !== 'identity') {
        response.destroy(); return reject(new Error('WEB_ENCODING_UNSUPPORTED'));
      }
      const body = decoder ?? response;
      let size = 0; let wireSize = 0; let charged = 0;
      const charge = () => {
        signal.throwIfAborted();
        if (Math.max(size, wireSize) > maxBytes) throw new Error('WEB_PAGE_TOO_LARGE');
        const total = Math.max(size, wireSize); onBytes?.(total - charged); charged = total;
      };
      const abortBody = () => { response.destroy(new Error('WEB_READ_TIMEOUT')); decoder?.destroy(new Error('WEB_READ_TIMEOUT')); };
      signal.addEventListener('abort', abortBody, { once: true });
      response.on('error', error => decoder?.destroy(error));
      decoder?.on('error', () => {});
      if (decoder) response.on('data', chunk => {
        try { wireSize += chunk.length; charge(); }
        catch (error) { response.destroy(error); decoder?.destroy(error); }
      });
      const headers = {};
      for (const key of ['access-control-allow-origin', 'access-control-allow-credentials', 'content-security-policy']) {
        if (typeof response.headers[key] === 'string') headers[key] = response.headers[key];
      }
      const metadata = { type, status, headers, url: url.href };
      const chunks = async function* () {
        for await (const chunk of body) { size += chunk.length; if (!decoder) wireSize = size; charge(); yield chunk; }
        signal.throwIfAborted();
      };
      const read = async () => {
        try {
          if (decoder) response.pipe(decoder);
          if (signal.aborted) throw new Error('WEB_READ_TIMEOUT');
          if (consume) return { ...metadata, value: await consume(chunks(), metadata) };
          const buffered = []; for await (const chunk of chunks()) buffered.push(chunk);
          return { ...metadata, bytes: Buffer.concat(buffered) };
        } finally {
          signal.removeEventListener('abort', abortBody); response.destroy(); decoder?.destroy();
        }
      };
      read().then(accept, error => reject(decoder && /^Z_/.test(error.code ?? '') ? new Error('WEB_DECOMPRESSION_FAILED') : error));
    });
    request.on('error', reject);
  });
}

export async function downloadPublicResource(input, { types, maxBytes = 2 * 1024 * 1024, signal: externalSignal, onBytes, consume }) {
  let url = validatePublicURL(input);
  const timeout = AbortSignal.timeout(20000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const result = await download(url, signal, types, maxBytes, onBytes, consume);
      if (!result.redirect) return { ...result, url: url.href };
      if (hop === 5) throw new Error('WEB_TOO_MANY_REDIRECTS');
      url = validatePublicURL(new URL(result.redirect, url).href);
    }
  } catch (error) {
    if (/^WEB_[A-Z0-9_]+$/.test(error.message)) throw error;
    if (consume && !signal.aborted) throw error;
    throw new Error(signal.aborted ? 'WEB_READ_TIMEOUT' : 'WEB_FETCH_FAILED');
  }
}
