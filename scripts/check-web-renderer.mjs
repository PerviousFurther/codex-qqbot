// Explicit browser check only: stubbed DNS/HTTPS, deny-proxy Chromium, no real pages.
// Run only with operator authorization; ordinary offline checks do not launch Chromium.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import dns from 'node:dns/promises';
import https from 'node:https';
import { chromium } from 'playwright';
import { renderPublicWebpage } from '../lib/web-renderer.mjs';

if (!process.argv.includes('--browser-offline')) throw new Error('EXPLICIT_BROWSER_CHECK_REQUIRED');
const originalFetch = globalThis.fetch;
let browser; let hits = [];
const html = '<!doctype html><html><head><title>Offline render fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><h1>Local fixture</h1><img src="./icon.png"><img src="https://blocked.example/not-allowed.png"></body></html>';
const fixtures = new Map([
  ['https://github.com/direct', { body: html, type: 'text/html' }],
  ['https://github.com/start', { redirect: 'https://www.cppreference.com/wiki/final' }],
  ['https://www.cppreference.com/wiki/final', { body: html, type: 'text/html', encoding: 'gzip' }],
  ['https://github.com/blocked', { redirect: 'https://blocked.example/final' }],
  ['https://github.com/fixture.css', { redirect: 'https://githubassets.com/final.css' }],
  ['https://www.cppreference.com/fixture.css', { redirect: 'https://githubassets.com/final.css' }],
  ['https://githubassets.com/final.css', { body: 'body { background: #ddeeff; }', type: 'text/css' }],
]);
try {
  globalThis.fetch = async () => { throw new Error('FIXTURE_UNEXPECTED_FETCH'); };
  mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mock.method(https, 'get', (url, options, callback) => {
    hits.push(url.href);
    const fixture = fixtures.get(url.href) ?? { body: '', type: 'image/png' };
    const bytes = fixture.encoding === 'gzip' ? gzipSync(Buffer.from(fixture.body)) : Buffer.from(fixture.body ?? '');
    const response = Readable.from([bytes]); response.statusCode = fixture.redirect ? 302 : 200;
    response.headers = fixture.redirect ? { location: fixture.redirect } : {
      'content-type': fixture.type, ...(fixture.encoding ? { 'content-encoding': fixture.encoding } : {}),
    };
    queueMicrotask(() => callback(response)); return new EventEmitter();
  });
  syncBuiltinESMExports();
  browser = await chromium.launch({ headless: true, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const direct = await renderPublicWebpage(browser, 'https://github.com/direct', { wait_ms: 0 });
  assert.equal(direct.url, 'https://github.com/direct'); assert(direct.image.length > 0);
  assert(direct.text.includes('Local fixture')); assert(direct.blocked_resources > 0);
  assert(hits.includes('https://githubassets.com/final.css'));
  assert(hits.every(url => !url.includes('blocked.example')));
  hits = [];
  const redirected = await renderPublicWebpage(browser, 'https://github.com/start', { wait_ms: 0 });
  assert.equal(redirected.url, 'https://www.cppreference.com/wiki/final');
  assert.equal(redirected.title, 'Offline render fixture'); assert(redirected.image.length > 0);
  assert(hits.includes('https://www.cppreference.com/wiki/icon.png')); // Relative document URLs use the final origin/path.
  assert(hits.includes('https://githubassets.com/final.css')); // Resource redirects never go to a browser socket.
  assert(hits.every(url => !url.includes('blocked.example')));
  hits = [];
  await assert.rejects(renderPublicWebpage(browser, 'https://github.com/blocked', { wait_ms: 0 }), /WEB_DOMAIN_NOT_ALLOWED/);
  assert.deepEqual(hits, ['https://github.com/blocked']);
  console.log('Offline Chromium fixture checks passed: direct/gzip pages, document/resource redirects, final URL resolution and blocked destinations.');
} finally {
  await browser?.close(); mock.restoreAll(); syncBuiltinESMExports(); globalThis.fetch = originalFetch;
}
