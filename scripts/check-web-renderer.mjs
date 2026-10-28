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
let browser; let hits = []; const submissions = []; const approvalHosts = [];
const html = '<!doctype html><html><head><title>Offline render fixture</title><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0; min-height:3000px;background:linear-gradient(red,blue)"><h1>Local fixture</h1><img src="./icon.png"><img src="https://blocked.example/not-allowed.png"></body></html>';
const fixtures = new Map([
  ['https://github.com/interactive', { type: 'text/html', cookies: ['fixture_session=one; HttpOnly; Secure; SameSite=Lax'], body: `<!doctype html><html><body>
    <button id="toggle" onclick="document.getElementById('status').textContent='Expanded'">Expand</button><p id="status">Closed</p>
    <form action="/submit" method="POST"><input name="query" id="query"><button id="submit">Submit</button></form>
    <a id="navigate" href="/start">Navigate</a><a id="blocked" href="https://blocked.example/blocked-click">Blocked</a><iframe src="/embedded"></iframe>
    </body></html>` }],
  ['https://github.com/embedded', { body: '<p>Embedded verification fixture</p>', type: 'text/html' }],
  ['https://github.com/submit', { redirect: 'https://github.com/submitted', status: 303 }],
  ['https://github.com/submitted', { body: '<h1>Form accepted</h1>', type: 'text/html' }],
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
  const responseFor = (url, options, callback, body) => {
    hits.push(url.href);
    submissions.push({ url: url.href, method: options.method ?? 'GET', headers: options.headers, body: body?.toString() });
    const fixture = fixtures.get(url.href) ?? { body: '', type: 'image/png' };
    const bytes = fixture.encoding === 'gzip' ? gzipSync(Buffer.from(fixture.body)) : Buffer.from(fixture.body ?? '');
    const response = Readable.from([bytes]); response.statusCode = fixture.redirect ? fixture.status ?? 302 : 200;
    response.headers = fixture.redirect ? { location: fixture.redirect } : {
      'content-type': fixture.type, ...(fixture.cookies ? { 'set-cookie': fixture.cookies } : {}), ...(fixture.encoding ? { 'content-encoding': fixture.encoding } : {}),
    };
    queueMicrotask(() => callback(response));
  };
  mock.method(https, 'get', (url, options, callback) => {
    responseFor(url, options, callback); return new EventEmitter();
  });
  mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter(); request.end = body => responseFor(url, options, callback, body); return request;
  });
  syncBuiltinESMExports();
  browser = await chromium.launch({ headless: true, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const session = await openPublicWebpage(browser, 'https://github.com/direct', { wait_ms: 0, requestDomain: async (host, signal) => { assert(!signal.aborted); approvalHosts.push(host); return 'denied'; } });
  const direct = await session.snapshot();
  assert.equal(direct.url, 'https://github.com/direct'); assert(direct.image.length > 0);
  assert(direct.text.includes('Local fixture')); assert(direct.blocked_resources > 0);
  assert(hits.includes('https://githubassets.com/final.css'));
  assert(hits.every(url => !url.includes('blocked.example')));
  assert(approvalHosts.includes('blocked.example'));
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
  // More than 80 resources do not invalidate screenshots of the same page.
  await redirectedSession.page.evaluate(async () => {
    for (let index = 0; index < 81; index++) {
      await fetch(`/budget-${index}`).catch(() => {});
    }
  });
  const afterManyRequests = await redirectedSession.snapshot();
  assert(afterManyRequests.requests > 80); assert(afterManyRequests.image.length > 0);
  await redirectedSession.close();
  const interactive = await openPublicWebpage(browser, 'https://github.com/interactive', { wait_ms: 0 });
  const click = async selector => {
    const box = await interactive.page.locator(selector).boundingBox();
    await interactive.interact({ action: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2, wait_ms: 0 });
  };
  assert.equal(interactive.page.frames().length, 2);
  await click('#toggle');
  assert((await interactive.snapshot()).text.includes('Expanded'));
  await click('#query');
  await interactive.interact({ action: 'type', text: 'fixture input', wait_ms: 0 });
  await interactive.interact({ action: 'press', key: 'ControlOrMeta+A', wait_ms: 0 });
  await interactive.interact({ action: 'type', text: 'replacement', wait_ms: 0 });
  assert.equal(await interactive.page.locator('#query').inputValue(), 'replacement');
  await click('#submit');
  const submitted = await interactive.snapshot();
  assert.equal(submitted.url, 'https://github.com/submitted');
  assert(submitted.text.includes('Form accepted'));
  assert.equal(submissions.filter(item => item.url === 'https://github.com/submit').length, 1);
  const post = submissions.find(item => item.url === 'https://github.com/submit');
  assert.equal(post.method, 'POST'); assert.equal(post.body, 'query=replacement');
  assert.equal(post.headers.cookie, 'fixture_session=one');
  assert.equal(submissions.find(item => item.url === 'https://github.com/submitted').method, 'GET');
  await interactive.interact({ action: 'back', wait_ms: 0 });
  assert.equal(interactive.page.url(), 'https://github.com/interactive');
  await click('#navigate');
  assert.equal(interactive.page.url(), 'https://www.cppreference.com/wiki/final');
  assert((await interactive.snapshot()).text.includes('Local fixture'));
  await interactive.close();
  const denied = await openPublicWebpage(browser, 'https://github.com/interactive', { wait_ms: 0 });
  const blockedLink = await denied.page.locator('#blocked').boundingBox();
  await assert.rejects(denied.interact({ action: 'click', x: blockedLink.x + 5, y: blockedLink.y + 5, wait_ms: 0 }), error => error.message === 'WEB_DOMAIN_NOT_ALLOWED' && error.webDomain === 'blocked.example');
  assert(hits.every(url => !url.includes('blocked.example')));
  await denied.close();
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
  console.log('Offline Chromium fixture checks passed: persistent page, scroll/crop pixels, blank page, cancellation, click/type/keys/back, iframe, single-submit POST redirects and blocked destinations.');
} finally {
  await browser?.close(); mock.restoreAll(); syncBuiltinESMExports(); globalThis.fetch = originalFetch;
}
