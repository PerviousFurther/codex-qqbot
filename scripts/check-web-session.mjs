// Offline lifecycle checkpoints: fake browser/turn IPC, no browser or network.
import assert from 'node:assert/strict';
import { WebSession } from '../lib/web-session.mjs';
import { MediaTurnHub } from '../lib/media-turn.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';
import { registerWebTools } from '../lib/tools/web.mjs';
import { z } from 'zod';

let cleanup, launches = 0, browserCloses = 0, opens = 0, pageCloses = 0, checks = 0;
let active = true; const interactions = [];
const hub = new MediaTurnHub(async (_path, _id, clean) => {
  cleanup = clean;
  return { check: async () => { checks++; if (!active) throw new Error('WEB_TURN_EXPIRED'); },
    assertActive: () => { if (!active) throw new Error('WEB_TURN_EXPIRED'); }, close: clean };
});
const web = new WebSession({ eventSocket: '/fixture', watch: hub.watch.bind(hub),
  launch: async () => { launches++; return { isConnected: () => true, close: async () => { browserCloses++; } }; },
  open: async (_browser, url) => {
    opens++;
    let closed = false;
    return { listMedia: async () => ({ media: [{ media_id: 'fixture' }] }),
      readMedia: async options => ({ ...options, seconds: 1 }), subtitles: async () => ({ status: 'NOT_LOADED' }),
      upload: async (_id, file) => { await file.assertAccess(); return { selected: true, upload_confirmed: false }; },
      interact: async options => interactions.push(options), page: { url: () => url ?? 'about:blank' }, close: async () => { if (!closed) pageCloses++; closed = true; },
      snapshot: async options => { assert(!closed); return { url, ...options, image: Buffer.from('fixture') }; } };
  },
});
await web.openPage('one', { url: 'https://github.com/a' });
await web.openPage('one', { url: 'https://github.com/a' });
await web.openPage('one');
assert.equal(launches, 1); assert.equal(opens, 1);
assert.equal((await web.listMedia('one')).media[0].media_id, 'fixture');
assert.equal((await web.readMedia('one', { media_id: 'fixture', capture: false })).url, 'https://github.com/a');
assert.equal((await web.subtitles('one', { media_id: 'fixture' })).status, 'NOT_LOADED');
let sourceChecks = 0;
assert.equal((await web.upload('one', { element_id: 'fixture', file_name: 'fixture.bin' }, {
  load: async name => { assert.equal(name, 'fixture.bin'); return { assertAccess: async () => { sourceChecks++; } }; },
})).upload.upload_confirmed, false);
assert.equal(sourceChecks, 2);
await web.snapshot('one', { scroll_y: 500 });
assert.equal(opens, 1);
await web.interact('one', { action: 'click', x: 10, y: 20 });
assert.equal(interactions.length, 1); assert.equal(launches, 1);
await assert.rejects(web.snapshot('two'), /WEB_TURN_MISMATCH/);
// Queue rejection must leave the original turn usable.
await web.snapshot('one');
assert.throws(() => web.openPage('one', { url: 'https://127.0.0.1/' }), /WEB_/);
assert.equal(pageCloses, 0);
await web.openPage('one', { url: 'https://github.com/b' });
assert.equal(launches, 1); assert.equal(opens, 2); assert.equal(pageCloses, 1);
await web.closePage('one'); await web.closePage('one');
assert.equal(browserCloses, 1);
await web.openPage('one');
assert.equal(launches, 2);
active = false; await cleanup();
assert.equal(browserCloses, 2); assert.equal(web.turn, null);
assert(checks > 5);
await web.close();

// Closing during launch must await and dispose resources created after abort.
let release, began;
const started = new Promise(resolve => { began = resolve; });
const launched = new Promise(resolve => { release = resolve; });
let lateClose = 0, cleanLate;
const late = new WebSession({ eventSocket: '/fixture', watch: async (_p, _t, clean) => {
  cleanLate = clean; return { check: async () => {}, assertActive() {}, close: clean };
}, launch: async () => { began(); return launched; }, open: async () => { throw new Error('UNEXPECTED_OPEN'); } });
const operation = late.openPage('late');
const rejected = assert.rejects(operation, /WEB_TURN_EXPIRED/);
await started;
const cleaning = cleanLate();
release({ close: async () => { lateClose++; } });
await rejected; await cleaning;
assert.equal(lateClose, 1); assert.equal(late.turn, null);

// Cookie credentials survive page/turn/process replacement and are shared across chats.
const { mkdtemp, rm, stat, utimes } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { Store } = await import('../lib/store.mjs');
const { scopeId } = await import('../lib/policy.mjs');
const cookieRoot = await mkdtemp(join(tmpdir(), 'web-cookies-'));
try {
  const store = new Store(cookieRoot);
  const cookie = { name: 'fixture', value: 'credential', domain: 'github.com', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' };
  const makeSession = scope => new WebSession({ store, scope, eventSocket: '/fixture',
    watch: async () => ({ check: async () => {}, assertActive() {}, close: async () => {} }),
    launch: async () => ({ isConnected: () => true, close: async () => {} }),
    open: async (_browser, url, options) => ({
      page: { url: () => url }, snapshot: async () => ({ restored: options.cookies }),
      persistCookies: () => options.saveCookies([cookie]), close: () => options.saveCookies([cookie]),
    }),
  });
  let first = makeSession('c2c:first');
  assert.deepEqual((await first.openPage('first', { url: 'https://github.com/' })).restored, []);
  await first.closePage('first'); await first.close();
  first = makeSession('c2c:first');
  assert.deepEqual((await first.openPage('next', { url: 'https://github.com/' })).restored, [cookie]);
  await first.close();
  const other = makeSession('c2c:other');
  assert.deepEqual((await other.openPage('other', { url: 'https://github.com/' })).restored, [cookie]);
  await other.close();
  assert.equal((await stat(join(cookieRoot, 'web-cookies', 'shared.sqlite'))).mode & 0o777, 0o600);
  const { WebCookies } = await import('../lib/web-cookies.mjs');
  const jar = new WebCookies(store);
  await assert.rejects(jar.save(null), /WEB_COOKIE_STATE_INVALID/);
  const baseline = await jar.load();
  const theme = { ...cookie, name: 'theme', value: 'dark' };
  await Promise.all([jar.save([...baseline, theme], baseline), new WebCookies(store).save([], baseline)]);
  assert.deepEqual(await jar.load(), [theme]);
  // A stale context closing without local changes must not restore logged-out credentials.
  await jar.save(baseline.map(cookie => Object.fromEntries(Object.entries(cookie).reverse())), baseline);
  assert.deepEqual(await jar.load(), [theme]);
  // A stale delete cannot remove a newer login for the same cookie.
  const renewed = { ...theme, value: 'new' };
  await jar.save([renewed], [theme]);
  await jar.save([], [theme]);
  assert.deepEqual(await jar.load(), [renewed]);
  // Independent processes merge different updates through SQLite transactions.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const moduleURL = new URL('../lib/web-cookies.mjs', import.meta.url).href;
  await Promise.all(['one', 'two'].map(name => run(process.execPath, ['--input-type=module', '-e',
    `import { WebCookies } from ${JSON.stringify(moduleURL)};
` +
    `await new WebCookies({root:process.argv[1]}).save([JSON.parse(process.argv[2])]);`,
    cookieRoot, JSON.stringify({ ...cookie, name })])));
  assert.deepEqual(new Set((await jar.load()).map(cookie => cookie.name)), new Set(['theme', 'one', 'two']));
  // One-time migration preserves old files and deterministically merges their jars.
  const legacyStore = new Store(join(cookieRoot, 'legacy'));
  const legacyPath = join(legacyStore.root, 'web-cookies', `${scopeId('c2c:legacy')}.json`);
  await legacyStore.write(legacyPath, { cookies: [cookie] });
  const legacyOther = join(legacyStore.root, 'web-cookies', `${scopeId('group:legacy-other')}.json`);
  const latestCookie = { ...cookie, value: 'newest' };
  await legacyStore.write(legacyOther, { cookies: [latestCookie] });
  await utimes(legacyPath, 100, 100); await utimes(legacyOther, 200, 200);
  const migrated = new WebCookies(legacyStore);
  assert.deepEqual(await migrated.load(), [latestCookie]);
  assert.deepEqual(await legacyStore.read(legacyPath), { cookies: [cookie] });
  await migrated.save([], [latestCookie]);
  assert.deepEqual(await new WebCookies(legacyStore).load(), []);

} finally { await rm(cookieRoot, { recursive: true, force: true }); }

// Failed credential writes must not retain a browser process or turn subscription.
let failedBrowserClosed = false, failedSubscriptionClosed = false;
const failedSave = new WebSession({ eventSocket: '/fixture',
  watch: async () => ({ check: async () => {}, assertActive() {}, close: async () => { failedSubscriptionClosed = true; } }),
  launch: async () => ({ close: async () => { failedBrowserClosed = true; } }),
  open: async () => ({ snapshot: async () => ({}), close: async () => { throw new Error('WEB_COOKIE_SAVE_FAILED'); } }),
});
await failedSave.openPage('save-failure');
await assert.rejects(failedSave.close(), /WEB_COOKIE_SAVE_FAILED/);
assert(failedBrowserClosed); assert(failedSubscriptionClosed); assert.equal(failedSave.turn, null);

const tools = new Map();
registerWebTools((name, description, schema, action) => tools.set(name, { description, schema: z.object(schema), action }), {}, {
  scope: 'group:fixture', store: { root: '/fixture', read: async () => ({ allowed: true, collection: true }) },
  stageImages: {}, webSession: {},
});
for (const name of tools.keys()) assert(Object.hasOwn(toolPolicy(), name));
assert(!Object.hasOwn(toolPolicy(), 'render_webpage'));
const turnId = '00000000-0000-4000-8000-000000000000';
assert(!tools.get('click_webpage').schema.safeParse({ turn_id: turnId, x: 1280, y: 0 }).success);
assert(!tools.get('press_webpage').schema.safeParse({ turn_id: turnId, key: 'Control+O' }).success);
assert(!tools.get('type_webpage').schema.safeParse({ turn_id: turnId, text: 'x'.repeat(6001) }).success);
assert(tools.get('open_webpage').schema.safeParse({ turn_id: '00000000-0000-4000-8000-000000000000' }).success);
assert(!tools.get('screenshot_webpage').schema.safeParse({ turn_id: 'bad' }).success);
assert(!tools.get('screenshot_webpage').schema.safeParse({ turn_id: '00000000-0000-4000-8000-000000000000',
  clip: { x: 1200, y: 0, width: 200, height: 100 } }).success);
// Verify the registered screenshot endpoint rechecks source access before
// publishing pixels acquired while collection is revoked.
let permitted = true, saved = 0;
const endpoints = new Map();
registerWebTools((name, _description, _schema, action) => endpoints.set(name, action), {}, {
  scope: 'group:fixture', store: { root: '/fixture', read: async () => ({ allowed: permitted }) },
  stageImages: { ensure: async () => {}, save: async () => { saved++; return { mimeType: 'image/jpeg', asset_id: 'fixture' }; } },
  webSession: { snapshot: async () => { permitted = false; return { image: Buffer.from('fixture'), url: 'https://github.com/' }; } },
});
await assert.rejects(endpoints.get('screenshot_webpage')({ turn_id: 'fixture' }), /GROUP_MESSAGES_DISABLED/);
assert.equal(permitted, false);
assert.equal(saved, 0);
console.log('Web session: reuse, navigation, early/turn close, launch cancellation, policy and schemas passed.');

// DOM projection/edit checks use synthetic element handles, never Chromium.
const { WebDom } = await import('../lib/web-dom.mjs');
const { EventEmitter } = await import('node:events');
const originalDocument = globalThis.document, originalStyle = globalThis.getComputedStyle;
const properties = new Map(); const documentRoot = { style: { setProperty: (key, value) => properties.set(key, value) } };
const makeNode = (tag, text, attributes = {}) => ({ tagName: tag.toUpperCase(), nodeType: 1, textContent: text, innerText: text,
  isConnected: true, baseURI: 'https://github.com/', childNodes: [{ nodeType: 3, textContent: text }],
  getAttribute: key => attributes[key] ?? null, getBoundingClientRect: () => ({ x: 5, y: 6, width: 80, height: 40 }),
  style: { setProperty: (key, value) => properties.set(key, value) }, remove() { this.isConnected = false; },
});
const overlay = makeNode('div', 'Advertisement', { class: 'overlay', onclick: 'SECRET_SCRIPT', 'data-secret': 'HIDDEN_SECRET' });
const button = makeNode('button', 'Close', { id: 'close', 'aria-label': 'Dismiss' });
let nodeList = [overlay, button], disposed = 0, elementClicks = 0;
const fakeHandle = node => ({ asElement() { return this; }, dispose: async () => { disposed++; },
  evaluate: async (fn, args) => fn(node, args), click: async () => { elementClicks++; },
});
const domPage = new EventEmitter(); const mainFrame = {};
domPage.mainFrame = () => mainFrame;
domPage.evaluateHandle = async (fn, args) => {
  const nodes = fn(args);
  return { getProperties: async () => new Map(nodes.map((node, index) => [String(index), fakeHandle(node)])),
    evaluate: async (projection, args) => projection(nodes, args), dispose: async () => {} };
};
globalThis.document = { querySelectorAll: selector => {
  if (selector === '[') throw new Error('Bad selector');
  return nodeList;
}, documentElement: documentRoot, body: documentRoot };
globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
const dom = new WebDom(domPage);
try {
  const first = await dom.read({ limit: 1, include_html: true });
  assert.equal(first.elements.length, 1); assert.equal(first.nextOffset, 1);
  assert(first.elements[0].html.includes('Advertisement'));
  assert(!JSON.stringify(first).includes('SECRET'));
  const oldId = first.elements[0].element_id;
  const second = await dom.read({ offset: 1, limit: 1 });
  await assert.rejects(dom.resolve(oldId), /WEB_DOM_STALE/);
  await (await dom.resolve(second.elements[0].element_id)).click(); assert.equal(elementClicks, 1);
  button.isConnected = false;
  await assert.rejects(dom.resolve(second.elements[0].element_id), /WEB_DOM_STALE/);
  button.isConnected = true;
  const popup = (await dom.read({ limit: 1 })).elements[0];
  await dom.edit(popup.element_id, 'hide', true);
  assert.equal(properties.get('display'), 'none'); assert.equal(properties.get('overflow'), 'auto');
  await assert.rejects(dom.resolve(popup.element_id), /WEB_DOM_STALE/);
  const removable = (await dom.read({ limit: 1 })).elements[0];
  await dom.edit(removable.element_id, 'remove'); assert.equal(overlay.isConnected, false);
  nodeList = [makeNode('textarea', 'PRIVATE_INPUT_VALUE')];
  const inputExcerpt = await dom.read({ limit: 1, include_html: true });
  assert(!JSON.stringify(inputExcerpt).includes('PRIVATE_INPUT_VALUE'));
  const svgScript = makeNode('script', 'PRIVATE_SCRIPT'); svgScript.tagName = 'script';
  const container = makeNode('div', 'Container'); container.childNodes = [svgScript]; nodeList = [container];
  assert(!(await dom.read({ limit: 1, include_html: true })).elements[0].html.includes('PRIVATE_SCRIPT'));
  const body = makeNode('body', 'Protected'); nodeList = [body];
  const protectedNode = (await dom.read()).elements[0];
  await assert.rejects(dom.edit(protectedNode.element_id, 'remove'), /WEB_DOM_EDIT_FORBIDDEN/);
  domPage.emit('framenavigated', mainFrame);
  await assert.rejects(dom.resolve(protectedNode.element_id), /WEB_DOM_STALE/);
  await assert.rejects(dom.read({ selector: '[' }), /WEB_DOM_SELECTOR_INVALID/);
  await assert.rejects(dom.read({ include_html: true, limit: 2 }), /WEB_DOM_QUERY_INVALID/);
  nodeList = Array.from({ length: 80 }, () => makeNode('div', 'x'.repeat(500), { class: 'y'.repeat(500) }));
  const bounded = await dom.read({ limit: 80 });
  assert(bounded.nextOffset > 0); assert(JSON.stringify(bounded.elements).length < 24500);
  assert(disposed > 0);
} finally {
  await dom.close();
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  if (originalStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = originalStyle;
}
assert(tools.get('click_webpage').schema.safeParse({ turn_id: turnId, element_id: turnId }).success);
assert(!tools.get('edit_webpage_dom').schema.safeParse({ turn_id: turnId, element_id: turnId, action: 'evaluate' }).success);
console.log('Web DOM: bounded projections/HTML, opaque references, stale/navigation rejection, element targeting, remove/hide, root protection and scroll unlock passed.');

// Generic player references, real fixed DOM functions and upload ownership.
{
const { EventEmitter } = await import('node:events');
const { WebPlayers, describeWebMedia, seekWebMedia, readWebTextTrack } = await import('../lib/web-players.mjs');
const { WebUploads } = await import('../lib/web-uploads.mjs');
const page = new EventEmitter();
const mediaNode = { tagName: 'VIDEO', isConnected: true, duration: 10, currentTime: 1, paused: true, readyState: 2,
  videoWidth: 1, videoHeight: 1, seekable: { length: 1, start: () => 0, end: () => 10 },
  buffered: { length: 1, start: () => 0, end: () => 3 },
  textTracks: [{ kind: 'subtitles', language: 'en', label: 'Fixture', mode: 'disabled', cues: [
    { startTime: 0, endTime: 2, text: 'fixture speech' }, { startTime: 8, endTime: 9, text: 'later' }] }] };
let mediaDisposals = 0;
const mediaHandle = { evaluate: async (fn, args) => fn(mediaNode, args), dispose: async () => { mediaDisposals++; },
  screenshot: async () => Buffer.from('actual fixture pixels') };
page.frames = () => [{ $$: async () => [mediaHandle] }];
const players = new WebPlayers(page);
let listed = await players.list(); let mediaId = listed.media[0].media_id;
assert.equal(listed.media[0].duration, 10); assert.equal(listed.media[0].kind, 'video');
assert(!JSON.stringify(listed).includes('https://'));
const playerFrame = await players.read({ media_id: mediaId });
assert.equal(playerFrame.capture, 'video_element'); assert.equal(playerFrame.seconds, 1);
assert(playerFrame.image.equals(Buffer.from('actual fixture pixels')));
assert.equal((await players.subtitles({ media_id: mediaId, start: 0, end: 3 })).cues.length, 1);
assert.equal(mediaNode.textTracks[0].mode, 'hidden');
await assert.rejects(players.subtitles({ media_id: mediaId, end: 121 }), /WEB_MEDIA_SUBTITLE_RANGE_INVALID/);
mediaNode.mediaKeys = {}; await assert.rejects(players.read({ media_id: mediaId }), /WEB_MEDIA_ENCRYPTED/); mediaNode.mediaKeys = null;
mediaNode.tagName = 'AUDIO';
assert.equal((await players.read({ media_id: mediaId, capture: false })).kind, 'audio');
await assert.rejects(players.read({ media_id: mediaId }), /WEB_MEDIA_VIDEO_REQUIRED/); mediaNode.tagName = 'VIDEO';
// Real Playwright evaluate failures prefix the first line and append a stack.
// Preserve fixed owner codes through the session and MCP failure projection.
const originalEvaluate = mediaHandle.evaluate, originalScreenshot = mediaHandle.screenshot;
const errorSession = new WebSession({ eventSocket: '/fixture-errors', watch: async () => ({
  check: async () => {}, assertActive: () => {}, close: async () => {},
}) });
const { toolFailure } = await import('../lib/tools/register.mjs');
for (const code of ['WEB_MEDIA_SEEK_TIMEOUT', 'WEB_MEDIA_TIMESTAMP_MISMATCH',
  'WEB_MEDIA_OUTSIDE_SEEKABLE_RANGE', 'WEB_MEDIA_PLAYBACK_ERROR',
  'WEB_MEDIA_ENCRYPTED', 'WEB_MEDIA_FRAME_CALLBACK_UNSUPPORTED', 'WEB_MEDIA_SEEK_FAILED']) {
  mediaHandle.evaluate = async (fn, args) => {
    if (fn === seekWebMedia) throw new Error(`elementHandle.evaluate: Error: ${code}\n    at fixture`);
    return originalEvaluate(fn, args);
  };
  const failure = await errorSession.run(turnId, () => players.read({ media_id: mediaId, seconds: 2 }))
    .then(() => assert.fail('Expected a media error'), error => error);
  assert.equal(failure.message, code);
  const result = toolFailure(failure);
  assert.equal(result.isError, true);
  const blocks = await result.content[0].to('mcp.content').single();
  assert.equal(JSON.parse(blocks[0].text).code, code);
}
for (const message of ['private text WEB_MEDIA_SEEK_TIMEOUT',
  'elementHandle.evaluate: Error: WEB_MEDIA_UNKNOWN',
  'elementHandle.evaluate: Error: private URL\nWEB_MEDIA_SEEK_TIMEOUT']) {
  mediaHandle.evaluate = async (fn, args) => {
    if (fn === seekWebMedia) throw new Error(message);
    return originalEvaluate(fn, args);
  };
  await assert.rejects(players.read({ media_id: mediaId, seconds: 2 }), { message: 'WEB_MEDIA_EVALUATION_FAILED' });
}
mediaHandle.evaluate = async (fn, args) => {
  if (fn === readWebTextTrack) throw new Error('elementHandle.evaluate: Error: WEB_MEDIA_TRACK_NOT_FOUND\n    at fixture');
  return originalEvaluate(fn, args);
};
await assert.rejects(players.subtitles({ media_id: mediaId }), { message: 'WEB_MEDIA_TRACK_NOT_FOUND' });
mediaHandle.evaluate = originalEvaluate;
for (const [name, code] of [['TimeoutError', 'WEB_MEDIA_SCREENSHOT_TIMEOUT'], ['Error', 'WEB_MEDIA_SCREENSHOT_FAILED']]) {
  mediaHandle.screenshot = async () => { throw Object.assign(new Error('private text'), { name }); };
  await assert.rejects(players.read({ media_id: mediaId }), { message: code });
}
mediaHandle.screenshot = originalScreenshot;
await errorSession.close();
await players.list(); await assert.rejects(players.read({ media_id: mediaId }), /WEB_MEDIA_STALE/);
listed = await players.list(); mediaId = listed.media[0].media_id;
page.emit('framenavigated', {}); await assert.rejects(players.read({ media_id: mediaId }), /WEB_MEDIA_STALE/);
await players.close(); assert(mediaDisposals >= 3); assert.equal(page.listenerCount('framenavigated'), 0);
const live = describeWebMedia({ ...mediaNode, duration: Infinity }); assert.equal(live.duration, null); assert.equal(live.live, true);
assert.equal(readWebTextTrack(mediaNode, { track_index: 0, start: 4, end: 5 }).status, 'NO_CUES_IN_WINDOW');
assert.throws(() => readWebTextTrack(mediaNode, { track_index: 8, start: 0, end: 1 }), /WEB_MEDIA_TRACK_NOT_FOUND/);
const seeking = new EventEmitter(); seeking.tagName = 'VIDEO'; seeking.seekable = mediaNode.seekable; seeking.readyState = 2;
seeking.currentTime = 2; seeking.pause = () => {}; seeking.play = async () => {};
seeking.addEventListener = seeking.on; seeking.removeEventListener = seeking.off;
seeking.requestVideoFrameCallback = callback => { queueMicrotask(() => callback(0, { mediaTime: 2 })); return 1; };
seeking.cancelVideoFrameCallback = () => {};
assert.equal(await seekWebMedia(seeking, 2), 2);
assert.equal(seeking.listenerCount('error'), 0); assert.equal(seeking.listenerCount('seeked'), 0);
await assert.rejects(seekWebMedia(seeking, 10), /WEB_MEDIA_OUTSIDE_SEEKABLE_RANGE/);
seeking.requestVideoFrameCallback = callback => { queueMicrotask(() => callback(0, { mediaTime: 8 })); return 1; };
await assert.rejects(seekWebMedia(seeking, 2), /WEB_MEDIA_TIMESTAMP_MISMATCH/);

let fileAllowed = true, chosen, fileChecks = 0;
const file = { name: 'fixture.bin', mimeType: 'application/octet-stream', bytes: Buffer.alloc(70000, 65),
  assertAccess: async () => { fileChecks++; if (!fileAllowed) throw new Error('FILE_CHANGED'); } };
page.waitForTimeout = async () => {};
let chooserMode = false;
const target = { evaluate: async () => !chooserMode, setInputFiles: async payload => { chosen = payload; },
  click: async () => page.emit('filechooser', { setFiles: async payload => { chosen = payload; } }) };
const uploads = new WebUploads(page, { resolve: async id => { if (id === 'stale') throw new Error('WEB_DOM_STALE'); return target; } });
assert.equal((await uploads.select('input', file, 0)).upload_confirmed, false);
assert(chosen.buffer.equals(file.bytes)); assert.equal(chosen.name, 'fixture.bin'); assert(!('path' in chosen));
const body = Buffer.concat([Buffer.from('multipart head'), file.bytes, Buffer.from('multipart tail')]);
const grant = await uploads.request(body); assert(grant.maxBodyBytes >= body.length); assert(fileChecks >= 4);
assert.deepEqual(await uploads.request(Buffer.alloc(80000, 66)), {});
fileAllowed = false;
await assert.rejects(grant.beforeRequest(), /FILE_CHANGED/);
await assert.rejects(uploads.select('input', file), /FILE_CHANGED/);
fileAllowed = true; chooserMode = true;
await uploads.select('button', file, 0); assert.equal(page.listenerCount('filechooser'), 0);
await assert.rejects(uploads.select('stale', file), /WEB_DOM_STALE/);
uploads.close(); assert.deepEqual(await uploads.request(body), {});
console.log('Web media/upload: discovery, frames, text tracks, seeking, stale/DRM/range errors, file chooser, byte grants and live rechecks passed.');
}

// Rendering normalization must not erase non-WEB acquisition/tool codes.
for (const original of [new Error('IMAGE_TOO_LARGE'),
  Object.assign(new Error('private network detail'), { code: 'ECONNRESET' }),
  new Error('fetch failed', { cause: Object.assign(new Error('private host'), { code: 'ENOTFOUND' }) })]) {
  const fixtureHub = new MediaTurnHub(async (_path, _id, clean) => ({
    check: async () => {}, assertActive() {}, close: clean,
  }));
  const fixture = new WebSession({ eventSocket: '/fixture', watch: fixtureHub.watch.bind(fixtureHub),
    launch: async () => ({ isConnected: () => true, close: async () => {} }),
    open: async () => { throw original; },
  });
  await assert.rejects(fixture.openPage('error-code-fixture', { url: 'https://github.com/' }),
    error => error.message === (original.code ?? original.cause?.code ?? original.message));
  await fixture.closePage('error-code-fixture');
}

// Exercise the real renderer's cookie synchronization with fake browser objects.
{
  const { openPublicWebpage } = await import('../lib/web-renderer.mjs');
  const { EventEmitter } = await import('node:events');
  const root = await mkdtemp(join(tmpdir(), 'shared-render-cookies-'));
  const { WebCookies } = await import('../lib/web-cookies.mjs');
  const jar = new WebCookies(new Store(root));
  const cookie = { name: 'session', value: 'old', domain: 'github.com', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax' };
  let renderer, contextClosed = false, failRestore = false, current = [cookie];
  try {
    await jar.save([cookie]);
    const page = Object.assign(new EventEmitter(), {
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, waitForTimeout: async () => {}, url: () => 'about:blank',
    });
    const context = Object.assign(new EventEmitter(), {
      routeWebSocket: async () => {}, addInitScript: async () => {}, newPage: async () => page,
      route: async () => {}, cookies: async () => structuredClone(current), clearCookies: async () => { current = []; },
      addCookies: async cookies => { if (failRestore) throw new Error('FIXTURE_RESTORE_FAILED'); current = structuredClone(cookies); },
      close: async () => { contextClosed = true; },
    });
    renderer = await openPublicWebpage({ newContext: async options => {
      assert.deepEqual(options.storageState.cookies, [cookie]); return context;
    } }, undefined, { wait_ms: 0, cookies: [cookie], loadCookies: () => jar.load(), saveCookies: (next, previous) => jar.save(next, previous) });
    const renewed = { ...cookie, value: 'new' };
    await jar.save([renewed], [cookie]);
    await renderer.syncCookies();
    assert.deepEqual(current, [renewed]);
    current = []; // Website logout in this context publishes a shared deletion.
    await renderer.persistCookies();
    assert.deepEqual(await jar.load(), []);
    await jar.save([renewed]);
    failRestore = true;
    await assert.rejects(renderer.syncCookies(), /FIXTURE_RESTORE_FAILED/);
    await renderer.close();
    assert(contextClosed);
    assert.deepEqual(await jar.load(), [renewed]); // A failed restore must not log out the shared account.
  } finally { await renderer?.close(); await rm(root, { recursive: true, force: true }); }
}
console.log('Shared website cookies: cross-chat/process merges, migration, logout, stale writes and renderer synchronization passed.');
