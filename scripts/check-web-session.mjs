// Offline lifecycle checkpoints: fake browser/turn IPC, no browser or network.
import assert from 'node:assert/strict';
import { WebSession } from '../lib/web-session.mjs';
import { MediaTurnHub } from '../lib/media-turn.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';
import { registerWebTools } from '../lib/tools/web.mjs';
import { z } from 'zod';

let cleanup, launches = 0, browserCloses = 0, opens = 0, pageCloses = 0, checks = 0;
let active = true;
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
    return { page: { url: () => url ?? 'about:blank' }, close: async () => { if (!closed) pageCloses++; closed = true; },
      snapshot: async options => { assert(!closed); return { url, ...options, image: Buffer.from('fixture') }; } };
  },
});
await web.openPage('one', { url: 'https://github.com/a' });
await web.openPage('one', { url: 'https://github.com/a' });
await web.openPage('one');
assert.equal(launches, 1); assert.equal(opens, 1);
await web.snapshot('one', { scroll_y: 500 });
assert.equal(opens, 1);
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
