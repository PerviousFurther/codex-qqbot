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
let nodeList = [overlay, button], disposed = 0, elementClicks = 0, clickTrials = 0, duringTrial;
const fakeHandle = node => ({ asElement() { return this; }, dispose: async () => { disposed++; },
  evaluate: async (fn, args) => fn(node, args), click: async options => {
    if (options?.trial) { clickTrials++; await duringTrial?.(node); }
    else elementClicks++;
  },
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
  assert(!JSON.stringify(first).includes('identity')); assert(!JSON.stringify(first).includes('connected'));
  assert(!JSON.stringify(first).includes('PRIVATE_INPUT_VALUE'));
  const oldId = first.elements[0].element_id;
  const second = await dom.read({ offset: 1, limit: 1 });
  await assert.rejects(dom.resolve(oldId), /WEB_DOM_STALE/);
  await dom.click(second.elements[0].element_id); assert.equal(elementClicks, 1); assert.equal(clickTrials, 1);
  button.isConnected = false;
  await assert.rejects(dom.resolve(second.elements[0].element_id), /WEB_DOM_STALE/);
  button.isConnected = true;
  // Target identity is scoped to semantic features, not a global DOM revision.
  const liveAttributes = { role: 'button', 'aria-label': 'Open details', class: 'original' };
  const control = makeNode('button', 'View details', liveAttributes); nodeList = [control];
  const observeControl = async () => (await dom.read({ limit: 1 })).elements[0].element_id;
  let controlId = await observeControl(); let clicksBefore = elementClicks;
  liveAttributes.class = 'animated'; control.value = 'typed text'; control.innerText = ' View   details\n';
  control.getBoundingClientRect = () => ({ x: 120, y: 200, width: 90, height: 30 });
  nodeList.push(makeNode('p', 'Unrelated real-time update'));
  await dom.click(controlId); await dom.click(controlId);
  assert.equal(elementClicks, clicksBefore + 2); // No click deduplication.
  const changed = async mutate => {
    controlId = await observeControl(); clicksBefore = elementClicks;
    mutate(); await assert.rejects(dom.click(controlId), /WEB_DOM_CHANGED/);
    assert.equal(elementClicks, clicksBefore);
    await assert.rejects(dom.click(controlId), /WEB_DOM_STALE/); // Never rebind the same ID.
  };
  await changed(() => { control.innerText = 'Confirm payment'; });
  await changed(() => { liveAttributes.role = 'link'; });
  await changed(() => { liveAttributes.type = 'submit'; });
  await changed(() => { liveAttributes['aria-label'] = 'Pay now'; });
  await changed(() => { liveAttributes.href = '/new-destination'; });
  control.form = { action: 'https://github.com/preview', method: 'get', target: '_self' };
  await changed(() => { control.form.action = 'https://github.com/commit'; });
  control.disabled = false;
  await changed(() => { control.disabled = true; });
  control.innerText = 'x'.repeat(400) + 'original';
  await changed(() => { control.innerText = 'x'.repeat(400) + 'changed'; }); // Beyond the 300-character preview.
  controlId = await observeControl(); clicksBefore = elementClicks;
  duringTrial = node => { node.innerText = 'Changed while preparing'; };
  await assert.rejects(dom.click(controlId), /WEB_DOM_CHANGED/);
  assert.equal(elementClicks, clicksBefore);
  duringTrial = () => { throw Object.assign(new Error('Blocked'), { name: 'TimeoutError' }); };
  controlId = await observeControl();
  await assert.rejects(dom.click(controlId), /WEB_DOM_NOT_ACTIONABLE/);
  assert.equal(elementClicks, clicksBefore);
  duringTrial = undefined;
  controlId = await observeControl(); control.isConnected = false;
  nodeList = [makeNode('button', control.innerText, liveAttributes)];
  await assert.rejects(dom.click(controlId), /WEB_DOM_STALE/);
  assert.equal(elementClicks, clicksBefore); // Replacement is never selected.
  nodeList = [overlay, button];
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
console.log('Web DOM: bounded projections/HTML, opaque references, stale/navigation rejection, element targeting, remove/hide, root protection, scroll unlock, semantic click checks, preparation-time changes and harmless dynamic updates passed.');

// Observation failures retain the page; callers can inspect/dismiss/retry using
// fresh observations. Unknown post-input failures keep terminal cleanup behavior.
let recoverable = 'WEB_DOM_CHANGED', retainedCloses = 0, observedAgain = 0;
const retained = new WebSession({ eventSocket: '/fixture',
  watch: async () => ({ check: async () => {}, assertActive() {}, close: async () => {} }),
  launch: async () => ({ isConnected: () => true, close: async () => {} }),
  open: async () => ({ page: { url: () => 'about:blank' },
    interact: async () => { throw new Error(recoverable); },
    readDom: async () => { observedAgain++; return { elements: [] }; },
    snapshot: async () => ({ url: 'about:blank' }), close: async () => { retainedCloses++; },
  }),
});
try {
  await retained.openPage('retained');
  for (const code of ['WEB_DOM_CHANGED', 'WEB_DOM_STALE', 'WEB_DOM_NOT_ACTIONABLE']) {
    recoverable = code;
    await assert.rejects(retained.interact('retained', { action: 'click', element_id: turnId }), error => error.message === code);
    assert.equal(retainedCloses, 0); await retained.readDom('retained');
  }
  assert.equal(observedAgain, 3);
  recoverable = 'WEB_FETCH_FAILED';
  await assert.rejects(retained.interact('retained', { action: 'click', element_id: turnId }), /WEB_FETCH_FAILED/);
  assert.equal(retainedCloses, 1);
  await assert.rejects(retained.readDom('retained'), /WEB_PAGE_NOT_OPEN/);
} finally { await retained.close(); }
console.log('Web observation recovery: changed/stale/blocked targets retain the page; unknown failures close it.');
