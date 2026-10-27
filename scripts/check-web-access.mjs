// Offline only: all DNS and HTTPS calls below are stubbed; no browser launches.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WEB_ALLOWED_DOMAINS } from '../lib/web-access-policy.mjs';
import { validatePublicURL, downloadPublicResource } from '../lib/public-resource.mjs';
import { WebReader } from '../lib/web-reader.mjs';
import { CodexAdapter } from '../lib/codex-adapter.mjs';
import { Files } from '../lib/files.mjs';
import { Store } from '../lib/store.mjs';

let lookups = 0; let requests = 0; let fixtureBody = null; let redirect = 'https://blocked.example/redirected';
const dnsStub = mock.method(dns, 'lookup', async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; });
const httpsStub = mock.method(https, 'get', (url, options, callback) => {
  requests++;
  if (fixtureBody) {
    const response = Readable.from([fixtureBody.bytes]); response.statusCode = 200;
    response.headers = { 'content-type': 'text/plain', 'content-encoding': fixtureBody.encoding };
    queueMicrotask(() => callback(response)); return new EventEmitter();
  }
  const response = new EventEmitter(); response.statusCode = 302;
  response.headers = { location: redirect }; response.destroy = () => {};
  queueMicrotask(() => callback(response));
  return new EventEmitter();
});
syncBuiltinESMExports();
const root = await mkdtemp(join(tmpdir(), 'watch-web-access-'));
const reader = new WebReader(); let adapter;
try {
  for (const url of ['https://bilibili.com/video/test', 'https://www.cppreference.com/w/cpp', 'https://github.com/openai/codex']) {
    assert.equal(validatePublicURL(url).href, url);
  }
  for (const url of [
    'https://unknown.example/', 'https://github.com.evil.example/', 'https://evilgithub.com/',
    'https://github.com./', 'https://gіthub.com/', 'https://github.com@evil.example/',
    'http://127.0.0.1/', 'http://2130706433/', 'https://github.com:8443/', 'file:///etc/passwd',
  ]) assert.throws(() => validatePublicURL(url), /WEB_/);
  await assert.rejects(downloadPublicResource('https://blocked.example/', { types: /text/ }), /WEB_DOMAIN_NOT_ALLOWED/);
  // Cache hits and render entry cannot bypass validation or launch Chromium.
  reader.cache.set('https://blocked.example/', { at: Date.now(), text: 'cached' });
  await assert.rejects(reader.read('https://blocked.example/', 0, 1000), /WEB_DOMAIN_NOT_ALLOWED/);
  await assert.rejects(reader.render('https://blocked.example/', {}), /WEB_DOMAIN_NOT_ALLOWED/);
  assert.equal(reader.browser, undefined); assert.equal(lookups, 0); assert.equal(requests, 0);
  // A redirect out of the list stops before DNS/socket access to the target.
  await assert.rejects(downloadPublicResource('https://github.com/redirect', { types: /text/ }), /WEB_DOMAIN_NOT_ALLOWED/);
  assert.equal(lookups, 1); assert.equal(requests, 1);
  // Adult domains fail before cache, rendering, DNS or redirected target access.
  const beforeAdult = { lookups, requests };
  reader.cache.set('https://onlyfans.com/', { at: Date.now(), text: 'cached adult content' });
  await assert.rejects(reader.read('https://onlyfans.com/', 0, 1000), /WEB_ADULT_SITE_BLOCKED/);
  await assert.rejects(reader.render('https://fansly.com/', {}), /WEB_ADULT_SITE_BLOCKED/);
  assert.equal(reader.browser, undefined);
  assert.deepEqual({ lookups, requests }, beforeAdult);
  redirect = 'https://onlyfans.com/';
  await assert.rejects(downloadPublicResource('https://github.com/redirect', { types: /text/ }), /WEB_ADULT_SITE_BLOCKED/);
  assert.equal(lookups, beforeAdult.lookups + 1); assert.equal(requests, beforeAdult.requests + 1);
  redirect = 'https://blocked.example/redirected';


  const plain = Buffer.from('compressed public page '.repeat(100));
  for (const [encoding, compress] of [['identity', bytes => bytes], ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    fixtureBody = { encoding, bytes: compress(plain) }; let charged = 0;
    const result = await downloadPublicResource('https://github.com/page', { types: /text/, onBytes: bytes => { charged += bytes; } });
    assert.deepEqual(result.bytes, plain); assert.equal(charged, Math.max(plain.length, fixtureBody.bytes.length));
    const streamed = await downloadPublicResource('https://github.com/page', { types: /text/, consume: async chunks => {
      await new Promise(resolve => setImmediate(resolve));
      const pieces = []; for await (const chunk of chunks) pieces.push(chunk);
      return Buffer.concat(pieces);
    } });
    assert.deepEqual(streamed.value, plain); assert.equal(streamed.bytes, undefined);
  }
  fixtureBody = { encoding: 'identity', bytes: Buffer.from('streamed file') };
  const files = new Files({ store: new Store(root), scope: 'c2c:fixture' });
  await files.save({ name: 'download.txt', url: 'https://github.com/file' });
  assert.equal(await files.workspace.readText('download.txt'), 'streamed file');
  await assert.rejects(downloadPublicResource('https://github.com/consumer', { types: /text/,
    consume: async () => { throw new Error('FILE_UTF8_REQUIRED'); } }), /FILE_UTF8_REQUIRED/);
  fixtureBody = { encoding: 'gzip', bytes: gzipSync(Buffer.alloc(128 * 1024, 'a')) };
  await assert.rejects(downloadPublicResource('https://github.com/large', { types: /text/, maxBytes: 1024 }), /WEB_PAGE_TOO_LARGE/);
  fixtureBody = { encoding: 'identity', bytes: Buffer.alloc(1025) };
  await assert.rejects(downloadPublicResource('https://github.com/large', { types: /text/, maxBytes: 1024 }), /WEB_PAGE_TOO_LARGE/);
  fixtureBody = { encoding: 'gzip', bytes: Buffer.from('invalid compressed bytes') };
  await assert.rejects(downloadPublicResource('https://github.com/broken', { types: /text/ }), /WEB_DECOMPRESSION_FAILED/);
  fixtureBody = { encoding: 'unknown', bytes: Buffer.from('data') };
  await assert.rejects(downloadPublicResource('https://github.com/encoding', { types: /text/ }), /WEB_ENCODING_UNSUPPORTED/);
  fixtureBody = { encoding: 'br', bytes: brotliCompressSync(plain) };
  await assert.rejects(downloadPublicResource('https://github.com/budget', { types: /text/, onBytes: () => { throw new Error('WEB_RENDER_RESOURCE_LIMIT'); } }), /WEB_RENDER_RESOURCE_LIMIT/);


  // Verify the real thread configuration, using a fake native RPC session.
  const rpc = new EventEmitter(); const calls = [];
  rpc.request = async (method, params) => {
    calls.push({ method, params }); return { thread: { id: 'fixture' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', model: 'fixture' };
  };
  adapter = new CodexAdapter({ dataDir: root });
  const session = { rpc, cwd: root, threadId: null };
  adapter.session = async () => session;
  await adapter.prepare({ scope: 'c2c:fixture' });
  assert.deepEqual(calls[0].params.config['tools.web_search.allowed_domains'], WEB_ALLOWED_DOMAINS);
  assert.equal(calls[0].params.config.web_search, 'live');
  await session.bridge.close();
  console.log('Offline web-domain checks passed: pre-network rejection, redirect wall, cache/render gates, native search configuration and bounded HTTP decompression.');
} finally {
  await reader.close(); dnsStub.mock.restore(); httpsStub.mock.restore(); syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
