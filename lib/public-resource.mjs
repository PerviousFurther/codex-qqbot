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

async function download(url, signal, types, maxBytes, onBytes, consume, browserRequest) {
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
    const transport = url.protocol === 'https:' ? https : http;
    const send = browserRequest ? transport.request.bind(transport) : transport.get.bind(transport);
    const request = send(url, {
      signal, agent: false, family: 4,
      ...(browserRequest ? { method: browserRequest.method } : {}),
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
      headers: { 'user-agent': 'WatchVideoReader/1.0', accept: '*/*', ...browserRequest?.headers, 'accept-encoding': 'identity' },
    }, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const redirect = response.headers.location; response.destroy();
        if (!redirect) return reject(new Error('WEB_REDIRECT_INVALID'));
        return accept({ redirect, status });
      }
      if (!browserRequest && (status < 200 || status >= 300)) { response.destroy(); return reject(new Error(`WEB_HTTP_${status}`)); }
      const type = response.headers['content-type'] ?? (browserRequest && [204, 205].includes(status) ? 'text/plain' : '');
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
      for (const key of ['access-control-allow-origin', 'access-control-allow-credentials', 'content-security-policy',
        ...(browserRequest ? ['access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers', 'x-frame-options', 'referrer-policy'] : [])]) {
        if (typeof response.headers[key] === 'string') headers[key] = response.headers[key];
      }
      if (browserRequest && response.headers['set-cookie']) headers['set-cookie'] = [].concat(response.headers['set-cookie']).join('\n');
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
    if (browserRequest) request.end(browserRequest.body);
  });
}

// browserRequest is backend-only input from an intercepted browser request.
// File/text consumers omit it and retain the original GET-only acquisition path.
export async function downloadPublicResource(input, { types, maxBytes = 2 * 1024 * 1024, signal: externalSignal, onBytes, consume, browserRequest }) {
  let url = validatePublicURL(input);
  if (browserRequest) {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(browserRequest.method)
      || (browserRequest.body?.length ?? 0) > 64 * 1024) throw new Error('WEB_REQUEST_NOT_ALLOWED');
    browserRequest = { ...browserRequest, headers: Object.fromEntries(
      Object.entries(browserRequest.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])) };
    for (const key of ['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'content-length', 'accept-encoding']) delete browserRequest.headers[key];
  }
  const timeout = AbortSignal.timeout(20000);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const result = await download(url, signal, types, maxBytes, onBytes, consume, browserRequest);
      if (!result.redirect) return { ...result, url: url.href };
      if (hop === 5) throw new Error('WEB_TOO_MANY_REDIRECTS');
      const next = validatePublicURL(new URL(result.redirect, url).href);
      if (browserRequest) {
        if (next.origin !== url.origin) {
          for (const key of ['cookie', 'authorization']) delete browserRequest.headers[key];
        }
        if (result.status === 303 && browserRequest.method !== 'HEAD'
          || [301, 302].includes(result.status) && browserRequest.method === 'POST') {
          browserRequest = { ...browserRequest, method: 'GET', body: undefined };
          delete browserRequest.headers['content-type'];
        }
      }
      url = next;
    }
  } catch (error) {
    if (/^WEB_[A-Z0-9_]+$/.test(error.message)) throw error;
    if (consume && !signal.aborted) throw error;
    throw new Error(signal.aborted ? 'WEB_READ_TIMEOUT' : 'WEB_FETCH_FAILED');
  }
}
