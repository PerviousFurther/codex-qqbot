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
import { openPublicWebpage } from '../lib/web-renderer.mjs';

if (!process.argv.includes('--browser-offline')) throw new Error('EXPLICIT_BROWSER_CHECK_REQUIRED');
const originalFetch = globalThis.fetch;
let browser; let hits = [];
const html = '<!doctype html><html><head><title>Offline render fixture</title><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0; min-height:3000px;background:linear-gradient(red,blue)"><h1>Local fixture</h1><img src="./icon.png"><img src="https://blocked.example/not-allowed.png"></body></html>';
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
  const session = await openPublicWebpage(browser, 'https://github.com/direct', { wait_ms: 0 });
  const direct = await session.snapshot();
  assert.equal(direct.url, 'https://github.com/direct'); assert(direct.image.length > 0);
  assert(direct.text.includes('Local fixture')); assert(direct.blocked_resources > 0);
  assert(hits.includes('https://githubassets.com/final.css'));
  assert(hits.every(url => !url.includes('blocked.example')));
  const beforeScroll = hits.length;
  const scrolled = await session.snapshot({ scroll_y: 1000 });
  assert.equal(scrolled.scroll_y, 1000);
  const crop = await session.snapshot({ clip: { x: 10, y: 20, width: 200, height: 100 } });
  const pixels = async (image, region) => session.page.evaluate(async ({ data, region }) => {
    const decoded = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
    const canvas = document.createElement('canvas'); canvas.width = decoded.width; canvas.height = decoded.height;
    const context = canvas.getContext('2d'); context.drawImage(decoded, 0, 0);
    const [x, y, width, height] = region ?? [0, 0, decoded.width, decoded.height];
    const bytes = context.getImageData(x, y, width, height).data;
    let red = 0; for (let i = 0; i < bytes.length; i += 4) red += bytes[i];
    return { width: decoded.width, height: decoded.height, red: red / (bytes.length / 4) };
  }, { data: image.toString('base64'), region });
  const expected = await pixels(scrolled.image, [10, 20, 200, 100]);
  const actual = await pixels(crop.image);
  assert.equal(actual.width, 200); assert.equal(actual.height, 100);
  assert(Math.abs(expected.red - actual.red) < 5);
  assert.equal(hits.length, beforeScroll);
  await assert.rejects(session.snapshot({ clip: { x: 1200, y: 0, width: 200, height: 100 } }), /WEB_CLIP_OUT_OF_BOUNDS/);
  await session.close();
  assert(session.page.isClosed());
  hits = [];
  const redirectedSession = await openPublicWebpage(browser, 'https://github.com/start', { wait_ms: 0 });
  const redirected = await redirectedSession.snapshot();
  assert.equal(redirected.url, 'https://www.cppreference.com/wiki/final');
  assert.equal(redirected.title, 'Offline render fixture'); assert(redirected.image.length > 0);
  assert(hits.includes('https://www.cppreference.com/wiki/icon.png')); // Relative document URLs use the final origin/path.
  assert(hits.includes('https://githubassets.com/final.css')); // Resource redirects never go to a browser socket.
  assert(hits.every(url => !url.includes('blocked.example')));
  // Repeated observations retain the same page resource budget.
  await redirectedSession.page.evaluate(async () => {
    for (let index = 0; index < 81; index++) {
      await fetch(`/budget-${index}`).catch(() => {});
    }
  });
  await assert.rejects(redirectedSession.snapshot(), /WEB_RENDER_RESOURCE_LIMIT/);
  await redirectedSession.close();
  const abort = new AbortController();
  const cancelled = await openPublicWebpage(browser, null, { wait_ms: 0, signal: abort.signal });
  assert.equal((await cancelled.snapshot()).url, 'about:blank');
  abort.abort();
  await cancelled.close();
  assert(cancelled.page.isClosed());
  await assert.rejects(cancelled.snapshot(), /WEB_TURN_EXPIRED/);
  hits = [];
  await assert.rejects(openPublicWebpage(browser, 'https://github.com/blocked', { wait_ms: 0 }), /WEB_DOMAIN_NOT_ALLOWED/);
  assert.deepEqual(hits, ['https://github.com/blocked']);
  console.log('Offline Chromium fixture checks passed: persistent page, scroll/crop pixels, blank page, cancellation, redirects and blocked destinations.');
} finally {
  await browser?.close(); mock.restoreAll(); syncBuiltinESMExports(); globalThis.fetch = originalFetch;
}
