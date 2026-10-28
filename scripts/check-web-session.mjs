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
    return { interact: async options => interactions.push(options), page: { url: () => url ?? 'about:blank' }, close: async () => { if (!closed) pageCloses++; closed = true; },
      snapshot: async options => { assert(!closed); return { url, ...options, image: Buffer.from('fixture') }; } };
  },
});
await web.openPage('one', { url: 'https://github.com/a' });
await web.openPage('one', { url: 'https://github.com/a' });
await web.openPage('one');
assert.equal(launches, 1); assert.equal(opens, 1);
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

// Cookie credentials survive page/turn/process replacement, with separate chat jars.
const { mkdtemp, rm, stat } = await import('node:fs/promises');
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
  assert.deepEqual((await other.openPage('other', { url: 'https://github.com/' })).restored, []);
  await other.close();
  assert.equal((await stat(join(cookieRoot, 'web-cookies', `${scopeId('c2c:first')}.json`))).mode & 0o777, 0o600);
  await store.write(join(cookieRoot, 'web-cookies', `${scopeId('c2c:bad')}.json`), { cookies: null });
  const bad = makeSession('c2c:bad');
  await assert.rejects(bad.openPage('bad', { url: 'https://github.com/' }), /WEB_COOKIE_STATE_INVALID/);
  await bad.close();
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
