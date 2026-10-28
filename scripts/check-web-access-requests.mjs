// Offline approval checkpoints: disposable metadata, local IPC and fake QQ delivery.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { openPublicWebpage } from '../lib/web-renderer.mjs';
import { WebSession } from '../lib/web-session.mjs';
import { WebOperationBudget } from '../lib/web-operation-budget.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';
import { Store } from '../lib/store.mjs';
import { WebReader } from '../lib/web-reader.mjs';
import { WebAccessRequests } from '../lib/web-access-requests.mjs';
import { configureWebAccess } from '../lib/web-access-policy.mjs';
import { approvalHost, webAccessState } from '../lib/web-access-state.mjs';
import { authorizePublicURL, downloadPublicResource, validatePublicURL } from '../lib/public-resource.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { WebDomainClient } from '../lib/web-domain-client.mjs';
import { BotCommands } from '../lib/commands.mjs';
import { registerWebTools } from '../lib/tools/web.mjs';
import { toolRegistrar } from '../lib/tools/register.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-web-approvals-'));
const store = new Store(root), host = 'docs.approval-example.org';
let now = Date.now(), active = true;
const notices = [], events = [];
const controller = { store, admins: ['fixture-admin'], closed: false,
  groupAccess: { read: async () => ({ allowed: true, listen: true, engage: true }) },
  debug: { record: (...args) => events.push(args) },
  notifyAdmins: async report => { await report.beforeSend(); notices.push(report); },
};
const owner = new WebAccessRequests(controller, () => now);
controller.webAccessRequests = owner;
const options = { scope: 'group:fixture', requestId: 'fixture-turn', isActive: () => active,
  checkAccess: async () => { if (!active) throw new Error('REPLY_TURN_EXPIRED'); } };
let bridge;
try {
  configureWebAccess(root);
  assert.throws(() => validatePublicURL(`https://${host}/public`), /WEB_DOMAIN_NOT_ALLOWED/);
  const pending = await owner.request(host, options);
  assert.equal(pending.status, 'pending'); assert.equal(notices.length, 1);
  assert.equal((await owner.request(host, options)).status, 'pending'); assert.equal(notices.length, 1);
  const first = (await owner.read()).requests.find(item => item.host === host);
  assert(notices[0].buttons.rows[0][0].command.includes(first.id));
  assert(!JSON.stringify(await owner.read()).includes('fixture-admin'));
  await assert.rejects(owner.handle('c2c:ordinary', `/web-access allow ${first.id}`), /ADMIN_ACCESS_REVOKED/);
  await assert.rejects(owner.handle('group:fixture-admin', `/web-access allow ${first.id}`), /ADMIN_ACCESS_REVOKED/);
  const commands = new BotCommands(controller); const replies = [];
  await commands.dispatch({ text: `/web-access allow ${first.id}`, who: { private: false, admin: true, scope: 'group:fixture-admin' }, reply: async value => replies.push(value) });
  assert.equal((await owner.read()).approved.length, 0); assert.equal(replies.length, 1);
  await owner.handle('c2c:fixture-admin', `/web-access allow ${first.id}`);
  assert.equal(validatePublicURL(`https://${host}/public`).hostname, host);
  assert.throws(() => validatePublicURL(`https://sub.${host}/`), /WEB_DOMAIN_NOT_ALLOWED/);
  assert.throws(() => validatePublicURL('https://approval-example.org/'), /WEB_DOMAIN_NOT_ALLOWED/);
  // A separate acquisition process consumes the same persisted exact-host grant.
  const child = `import {configureWebAccess} from ${JSON.stringify(new URL('../lib/web-access-policy.mjs', import.meta.url).href)}; import {validatePublicURL} from ${JSON.stringify(new URL('../lib/public-resource.mjs', import.meta.url).href)}; configureWebAccess(process.argv[1]); console.log(validatePublicURL(process.argv[2]).hostname);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', child, root, `https://${host}/`], { encoding: 'utf8' }).trim(), host);
  await owner.handle('c2c:fixture-admin', `/web-access deny ${first.id}`);
  assert((await owner.read()).approved.includes(host));
  const cachedReader = new WebReader();
  cachedReader.cache.set('https://github.com/approval-cache', { at: Date.now(), url: `https://${host}/final`, text: 'fixture cached body' });
  assert.equal((await cachedReader.read('https://github.com/approval-cache', 0, 1000)).text, 'fixture cached body');
  await owner.handle('c2c:fixture-admin', `/web-access remove ${host}`);
  await assert.rejects(cachedReader.read('https://github.com/approval-cache', 0, 1000), /WEB_DOMAIN_NOT_ALLOWED/);
  await cachedReader.close();
  assert.throws(() => validatePublicURL(`https://${host}/`), /WEB_DOMAIN_NOT_ALLOWED/);
  const beforeAdult = notices.length;
  await assert.rejects(owner.request('onlyfans.com', options), /WEB_ADULT_SITE_BLOCKED/);
  for (const value of ['127.0.0.1', 'localhost', 'printer.local', 'foo.internal', 'foo.home.arpa', 'user@evil.example', 'evil.example/path']) assert.throws(() => approvalHost(value));
  assert.equal(notices.length, beforeAdult);
  await owner.request(host, options);
  let record = (await owner.read()).requests.find(item => item.host === host);
  await owner.handle('c2c:fixture-admin', `/web-access deny ${record.id}`);
  const rejectedCount = notices.length;
  assert.equal((await owner.request(host, options)).status, 'denied'); assert.equal(notices.length, rejectedCount);
  now += 3600001;
  await owner.request(host, options);
  record = (await owner.read()).requests.find(item => item.host === host);
  now += 600001;
  await owner.handle('c2c:fixture-admin', `/web-access allow ${record.id}`);
  assert(!(await owner.read()).approved.includes(host));
  active = false;
  await assert.rejects(owner.request('revoked.approval-example.org', options), /REPLY_TURN_EXPIRED/);
  active = true;
  await owner.request('race.approval-example.org', options);
  const race = (await owner.read()).requests.find(item => item.host.startsWith('race.'));
  await Promise.all([owner.handle('c2c:fixture-admin', `/web-access allow ${race.id}`), owner.handle('c2c:fixture-admin', `/web-access deny ${race.id}`)]);
  assert((await owner.read()).approved.includes(race.host));
  const originalWrite = store.write.bind(store); let fail = true;
  store.write = async (...args) => { if (fail) { fail = false; throw new Error('FIXTURE_WRITE_FAILED'); } return originalWrite(...args); };
  await assert.rejects(owner.request('atomic.approval-example.org', options), /FIXTURE_WRITE_FAILED/);
  assert(!(await owner.read()).requests.some(item => item.host.startsWith('atomic.')));
  await owner.request('atomic.approval-example.org', options);
  assert((await owner.read()).requests.some(item => item.host.startsWith('atomic.')));
  assert.throws(() => webAccessState({ version: 1, approved: ['only strings', 123], requests: [] }), /WEB_ACCESS_STATE_INVALID/);

  bridge = await ReplyBridge.open();
  const ipcNotices = [];
  const turn = bridge.bind({ id: 'fixture-token', webDomainRequest: async value => { ipcNotices.push(value); return { status: 'pending' }; } });
  const client = new WebDomainClient({ eventSocket: bridge.path, scope: 'group:fixture', store: { root, read: async () => ({ allowed: true }) } });
  assert.equal(await client.request(host, 'wrong-token'), 'unavailable'); assert.equal(ipcNotices.length, 0);
  assert.equal(await client.request(host, 'fixture-token'), 'pending');
  assert.equal(await client.request(host, 'fixture-token'), 'pending'); assert.equal(ipcNotices.length, 1);
  for (const value of ['one.approval-example.org', 'two.approval-example.org']) assert.equal(await client.request(value, 'fixture-token'), 'pending');
  assert.equal(await client.request('three.approval-example.org', 'fixture-token'), 'limited');
  await turn.close();
  assert.equal(await client.request('closed.approval-example.org', 'fixture-token'), 'unavailable');
  const noSending = bridge.bind({ id: 'no-requests' });
  assert.equal((await callReplyBridge(bridge.path, { action: 'web_domain_request', turn_id: 'no-requests', host })).code, 'TURN_ACTION_NOT_ALLOWED');
  await noSending.close();
  let failures = 0;
  const failedTurn = bridge.bind({ id: 'failed-request', webDomainRequest: async () => { failures++; throw new Error('FIXTURE_FAILURE'); } });
  assert.equal(await client.request(host, 'failed-request'), 'unavailable');
  assert.equal(await client.request(host, 'failed-request'), 'unavailable'); assert.equal(failures, 1);
  await failedTurn.close();
  let requestStarted;
  const acceptedRequest = new Promise(resolve => { requestStarted = resolve; });
  const cancelledTurn = bridge.bind({ id: 'cancel-request', webDomainRequest: (_host, signal) => new Promise(resolve => {
    requestStarted(); signal.addEventListener('abort', () => resolve({ status: 'pending' }), { once: true });
  }) });
  const abort = new AbortController();
  const cancelledRequest = client.request(host, 'cancel-request', abort.signal);
  await acceptedRequest; abort.abort();
  assert.equal(await cancelledRequest, 'unavailable');
  await cancelledTurn.close();

  const endpoints = new Map(); let requestedHost, requestedTurn;
  registerWebTools(toolRegistrar({ registerTool(name, _options, run) { endpoints.set(name, run); } }, toolPolicy()), {
    read: async (url, _offset, _limit, options) => authorizePublicURL(url, options),
  }, { scope: 'group:fixture', store: { root, read: async () => ({ allowed: true }) }, stageImages: {},
    webDomains: { check: async () => {}, wait: async (value, turnId) => { requestedHost = value; requestedTurn = turnId; return 'denied'; } },
  });
  const failedRead = await endpoints.get('read_webpage')({ url: 'https://blocked.example/private-path?SECRET_QUERY', turn_id: 'tool-turn' });
  assert(failedRead.isError);
  assert.equal(requestedHost, 'blocked.example'); assert.equal(requestedTurn, 'tool-turn');
  assert.equal(JSON.parse(failedRead.content[0].text).code, 'WEB_APPROVAL_DENIED');
  assert(!JSON.stringify(failedRead).includes('SECRET_QUERY'));


  // Real token-bound wait/status IPC and downloader, with synthetic DNS/HTTPS only.
  const waitingTurn = bridge.bind({ id: 'waiting-token', webDomainRequest: (value, signal, statusOnly) => {
    const checkAccess = async () => { if (signal?.aborted || !active) throw new Error('REPLY_TURN_EXPIRED'); };
    return statusOnly ? owner.status(value, checkAccess) : owner.request(value, { ...options, checkAccess });
  } });
  assert.equal((await callReplyBridge(bridge.path, { action: 'web_domain_status', turn_id: 'waiting-token', host: 'unrequested.example' })).code, 'TURN_ACTION_NOT_ALLOWED');
  const gate = (value, signal) => client.wait(value, 'waiting-token', signal);
  const until = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await delay(5); }
    throw new Error('FIXTURE_WAIT_TIMEOUT');
  };
  const decide = async (host, decision) => {
    await until(async () => (await owner.read()).requests.some(item => item.host === host && item.status === 'pending'));
    const record = (await owner.read()).requests.find(item => item.host === host);
    await owner.handle('c2c:fixture-admin', `/web-access ${decision} ${record.id}`);
  };
  const sockets = [];
  let responseBody = Buffer.from('fixture');
  mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    request.end = body => {
      sockets.push({ url: url.href, method: options.method, body: body?.toString(), headers: options.headers });
      const redirect = url.hostname === 'github.com';
      const response = Readable.from(redirect ? [] : [responseBody]);
      response.statusCode = redirect ? 307 : 200;
      response.headers = redirect ? { location: 'https://continue.approval-example.org/finish' } : { 'content-type': 'text/plain' };
      queueMicrotask(() => callback(response));
    };
    return request;
  });
  syncBuiltinESMExports();
  try {
    const resource = downloadPublicResource('https://github.com/submit', { types: /^text\/plain/, requestDomain: gate,
      browserRequest: { method: 'POST', body: Buffer.from('exact-body'), headers: {} } });
    await until(async () => (await owner.read()).requests.some(item => item.host === 'continue.approval-example.org'));
    assert.equal(sockets.length, 1); // First POST happened once; redirect has no socket yet.
    await decide('continue.approval-example.org', 'allow');
    assert.equal((await resource).bytes.toString(), 'fixture');
    assert.deepEqual(sockets.map(item => [item.method, item.body]), [['POST', 'exact-body'], ['POST', 'exact-body']]);
    const denied = authorizePublicURL('https://denied-wait.approval-example.org/', { requestDomain: gate });
    const rejected = assert.rejects(denied, /WEB_APPROVAL_DENIED/);
    await decide('denied-wait.approval-example.org', 'deny'); await rejected;
    assert.equal(sockets.length, 2);
    const cancelled = new AbortController();
    const stopping = assert.rejects(authorizePublicURL('https://cancel-wait.approval-example.org/',
      { requestDomain: gate, signal: cancelled.signal }), /AbortError/);
    await until(async () => (await owner.read()).requests.some(item => item.host === 'cancel-wait.approval-example.org'));
    cancelled.abort(); await stopping;
    await assert.rejects(authorizePublicURL('https://127.0.0.1/', { requestDomain: gate }), /WEB_APPROVAL_UNAVAILABLE/);
    // Exercise the actual browser route handler with a synthetic page. The
    // route must reach approval before DNS/HTTP, including POST navigation.
    let routeHandler, routePending = false, releaseRoute;
    const routeApproval = new Promise(resolve => { releaseRoute = resolve; });
    const routePage = new EventEmitter(); const routeFrame = { page: () => routePage };
    Object.assign(routePage, { mainFrame: () => routeFrame, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
      waitForTimeout: async () => {}, url: () => 'about:blank',
      evaluate: async () => ({ title: 'Synthetic page', text: '', scroll_y: 0 }),
      screenshot: async () => Buffer.from('synthetic pixels'),
      evaluateHandle: async () => ({ getProperties: async () => new Map(), evaluate: async () => [], dispose: async () => {} }) });
    const routeContext = new EventEmitter();
    Object.assign(routeContext, { routeWebSocket: async () => {}, addInitScript: async () => {}, newPage: async () => routePage,
      route: async (_pattern, handler) => { routeHandler = handler; }, close: async () => {} });
    const rendered = await openPublicWebpage({ newContext: async () => routeContext }, null, {
      wait_ms: 0, requestDomain: async host => { routePending = true; assert.equal(host, 'route-wait.approval-example.org'); await routeApproval; return 'approved'; },
    });
    let fulfilled = 0, aborted = 0;
    try {
      const routed = routeHandler({ request: () => ({ isNavigationRequest: () => true, frame: () => routeFrame,
        resourceType: () => 'document', url: () => 'https://route-wait.approval-example.org/submit', method: () => 'POST',
        allHeaders: async () => ({}), postDataBuffer: () => Buffer.from('route-body') }),
        fulfill: async () => { fulfilled++; }, abort: async () => { aborted++; } });
      await until(() => routePending);
      assert.equal(sockets.length, 2); assert.equal(fulfilled, 0); assert.equal(aborted, 0);
      await owner.request('route-wait.approval-example.org', options);
      await decide('route-wait.approval-example.org', 'allow'); releaseRoute();
      await routed;
      assert.equal(fulfilled, 1); assert.equal(aborted, 0);
      assert.equal(sockets.length, 3); assert.equal(sockets.at(-1).body, 'route-body');
      // Exercise cumulative traffic beyond both former caps without Chromium.
      responseBody = Buffer.alloc(512 * 1024, 97);
      for (let index = 0; index < 90; index++) await routeHandler({
        request: () => ({ isNavigationRequest: () => false, frame: () => routeFrame, resourceType: () => 'fetch',
          url: () => `https://route-wait.approval-example.org/resource-${index}`, method: () => 'GET',
          allHeaders: async () => ({}), postDataBuffer: () => null }),
        fulfill: async () => { fulfilled++; }, abort: async () => { aborted++; },
      });
      const snapshot = await rendered.snapshot();
      assert(snapshot.requests > 80); assert(snapshot.transferred_bytes > 32 * 1024 * 1024);
      assert.equal(snapshot.image.toString(), 'synthetic pixels'); assert.equal(aborted, 0);
      assert.equal(fulfilled, 91); responseBody = Buffer.from('fixture');
      // Real renderer upload and media routes, still entirely synthetic.
      let fileAllowed = true, selectedPayload;
      const uploadFile = { name: 'fixture.bin', mimeType: 'application/octet-stream', bytes: Buffer.alloc(70000, 65),
        assertAccess: async () => { if (!fileAllowed) throw new Error('FILE_CHANGED'); } };
      const input = { asElement() { return this; }, dispose: async () => {},
        evaluate: async fn => fn({ isConnected: true, tagName: 'INPUT', type: 'file' }),
        setInputFiles: async payload => { selectedPayload = payload; } };
      routePage.evaluateHandle = async () => ({ getProperties: async () => new Map([['0', input]]),
        evaluate: async () => [{ tag: 'input', attributes: { type: 'file' }, text: '', visible: false }], dispose: async () => {} });
      const uploadId = (await rendered.readDom({ selector: 'input[type=file]' })).elements[0].element_id;
      assert.equal((await rendered.upload(uploadId, uploadFile, 0)).upload_confirmed, false);
      assert(selectedPayload.buffer.equals(uploadFile.bytes)); assert(!('path' in selectedPayload));
      const submit = (body, headers = {}, type = 'fetch') => routeHandler({
        request: () => ({ isNavigationRequest: () => false, frame: () => routeFrame, resourceType: () => type,
          url: () => 'https://route-wait.approval-example.org/upload', method: () => body ? 'POST' : 'GET',
          allHeaders: async () => headers, postDataBuffer: () => body }),
        fulfill: async () => { fulfilled++; }, abort: async () => { aborted++; },
      });
      await submit(Buffer.concat([Buffer.from('header'), uploadFile.bytes, Buffer.from('tail')]));
      assert.equal(fulfilled, 92); assert.equal(aborted, 0);
      await submit(Buffer.alloc(70000, 66)); assert.equal(aborted, 1);
      fileAllowed = false; const beforeRevoke = sockets.length;
      await submit(uploadFile.bytes); assert.equal(aborted, 2); assert.equal(sockets.length, beforeRevoke);
      fileAllowed = true;
      await submit(null, { range: 'bytes=0-15' }, 'media');
      assert.equal(fulfilled, 93); assert.equal(sockets.at(-1).headers.range, 'bytes=0-15');

    } finally { releaseRoute(); await rendered.close(); }
    // Saved cookies reach the checked initial request, never a cross-origin redirect.
    const cookie = { name: 'fixture', value: 'secret', domain: 'github.com', path: '/', expires: -1,
      httpOnly: true, secure: true, sameSite: 'Lax' };
    let contextOptions, savedCookies, contextClosed = false;
    routePage.goto = async () => ({});
    routeContext.cookies = async url => { assert(!contextClosed); assert(!url || url === 'https://github.com/cookies'); return [cookie]; };
    routeContext.close = async () => { contextClosed = true; };
    const beforeCookies = sockets.length;
    const cookiePage = await openPublicWebpage({ newContext: async options => { contextOptions = options; return routeContext; } },
      'https://github.com/cookies', { cookies: [cookie], saveCookies: async value => { savedCookies = value; }, wait_ms: 0 });
    assert.deepEqual(contextOptions.storageState, { cookies: [cookie], origins: [] });
    assert.equal(sockets[beforeCookies].headers.cookie, 'fixture=secret');
    assert.equal(sockets[beforeCookies + 1].headers.cookie, undefined);
    await cookiePage.persistCookies(); assert.deepEqual(savedCookies, [cookie]);
    await cookiePage.close(); assert(contextClosed);
    // Credential publication failures still close the browser context.
    contextClosed = false;
    const failingPage = await openPublicWebpage({ newContext: async () => routeContext }, null,
      { saveCookies: async () => { throw new Error('fixture-sensitive-error'); }, wait_ms: 0 });
    await assert.rejects(failingPage.close(), /^Error: WEB_COOKIE_SAVE_FAILED$/); assert(contextClosed);
    let adultReview = false;
    await assert.rejects(authorizePublicURL('https://onlyfans.com/', { requestDomain: async () => { adultReview = true; } }), /WEB_ADULT_SITE_BLOCKED/);
    assert.equal(adultReview, false);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); await waitingTurn.close(); }
  // Initial open waits before allocating a browser. Revocation/cancellation
  // during that gate prevents launch, using the real policy and status owner.
  let launches = 0, clicks = 0;
  const openTurn = bridge.bind({ id: 'open-token', webDomainRequest: (value, signal, statusOnly) => {
    const checkAccess = async () => { if (signal?.aborted || !active) throw new Error('REPLY_TURN_EXPIRED'); };
    return statusOnly ? owner.status(value, checkAccess) : owner.request(value, { ...options, checkAccess });
  } });
  const fakeWeb = new WebSession({ eventSocket: bridge.path,
    watch: async () => ({ check: async () => {}, assertActive() {}, close: async () => {} }),
    requestDomain: (value, token, signal) => client.wait(value, token, signal),
    launch: async () => { launches++; return { isConnected: () => true, close: async () => {} }; },
    open: async (_browser, url, options) => ({ page: { url: () => url }, snapshot: async () => ({ url }), close: async () => {},
      interact: async () => { clicks++; await authorizePublicURL('https://click-wait.approval-example.org/', options); },
    }),
  });
  try {
    const opening = fakeWeb.openPage('open-token', { url: 'https://open-wait.approval-example.org/' });
    await until(async () => (await owner.read()).requests.some(item => item.host === 'open-wait.approval-example.org'));
    assert.equal(launches, 0);
    await decide('open-wait.approval-example.org', 'allow');
    assert.equal((await opening).url, 'https://open-wait.approval-example.org/'); assert.equal(launches, 1);
    const revoked = assert.rejects(fakeWeb.openPage('open-token', { url: 'https://revoked-wait.approval-example.org/' }), /WEB_RENDER_FAILED|WEB_TURN_EXPIRED/);
    await until(async () => (await owner.read()).requests.some(item => item.host === 'revoked-wait.approval-example.org'));
    active = false; await revoked; active = true;
    assert.equal(launches, 1);
    await fakeWeb.openPage('open-token', { url: 'https://open-wait.approval-example.org/' });
    const clicking = fakeWeb.interact('open-token', { action: 'click', x: 1, y: 1 });
    await until(async () => (await owner.read()).requests.some(item => item.host === 'click-wait.approval-example.org'));
    assert.equal(clicks, 1);
    await decide('click-wait.approval-example.org', 'allow'); await clicking;
    assert.equal(clicks, 1);
    const expiredHost = 'expire-wait.approval-example.org';
    await owner.request(expiredHost, options); now += 600001;
    assert.equal((await owner.status(expiredHost, options.checkAccess)).status, 'expired');
  } finally { active = true; await fakeWeb.close(); await openTurn.close(); }
  // Approval waiting does not consume active-work time, but concurrent waits
  // share an aggregate wait deadline and cancellation remains observable.
  const pausedBudget = new WebOperationBudget(10, undefined, 1000);
  try { await pausedBudget.wait(() => delay(30)); assert(!pausedBudget.signal.aborted); }
  finally { pausedBudget.close(); }
  const budget = new WebOperationBudget(1000, undefined, 30);
  try {
    await budget.wait(() => delay(5)); assert(!budget.signal.aborted);
    await Promise.allSettled([budget.wait(() => delay(1000, undefined, { signal: budget.signal })),
      budget.wait(() => delay(1000, undefined, { signal: budget.signal }))]);
    assert(budget.signal.aborted);
  } finally { budget.close(); }

  // Exercise the actual controller callback and failure-notice distinction
  // with a fake adapter. No inference/provider process is started.
  const modelNotices = [];
  let foregroundCapability = false, backgroundCapability = true;
  const serviceStore = new Store(join(root, 'service'));
  const service = new VideoController({ store: serviceStore, admins: ['fixture-admin'], adapter: {
    close: async () => {},
    run: async opts => {
      if (opts.onWebDomainRequest) {
        foregroundCapability = true;
        assert.equal((await opts.onWebDomainRequest('controller.approval-example.org')).status, 'pending');
        assert.equal((await opts.onWebDomainRequest('controller.approval-example.org', undefined, true)).status, 'pending');
        opts.onDiagnostic('mcp_failed', { tool: 'open_webpage', reason: 'WEB_DOMAIN_NOT_ALLOWED' });
      } else backgroundCapability = false;
      return { pauseBrowsing: false, sharedState: null };
    },
  } });
  service.notifyAdmins = async report => { await report.beforeSend?.(); modelNotices.push(report); };
  try {
    await service.run('c2c:fixture-admin', 'fixture', await serviceStore.conversation('c2c:fixture-admin'), { onReply: async () => {} });
    assert(foregroundCapability);
    assert.equal(modelNotices.length, 1); assert.equal(modelNotices[0].reason, 'WEB_DOMAIN_APPROVAL');
    await service.run('c2c:fixture-admin', 'fixture discovery', await serviceStore.conversation('c2c:fixture-admin'), { background: true, purpose: 'discover' });
    assert.equal(backgroundCapability, false); assert.equal(modelNotices.length, 1);
    assert(!JSON.stringify(service.debug.read('c2c:fixture-admin')).includes('controller.approval-example.org'));
    const groupScope = 'group:fixture-group';
    const group = { id: scopeId(groupScope), openid: 'fixture-group', allowed: true, listen: true, engage: true };
    service.groupAccess.read = async () => group; service.groupAccess.records = async () => [group];
    service.groupAccess.update = async (_id, change) => { await change(group); return group; };
    service.groupContext.snapshot = async () => ({ messages: [], epoch: 0 });
    service.adapter.run = async opts => {
      assert(opts.onWebDomainRequest);
      group.listen = false;
      await assert.rejects(opts.onWebDomainRequest('revoked-group.approval-example.org'), /COLLECTION_DISABLED/);
      await assert.rejects(opts.onWebDomainRequest('revoked-group.approval-example.org', undefined, true), /COLLECTION_DISABLED/);
      return { pauseBrowsing: false, sharedState: null };
    };
    await service.run(groupScope, 'fixture group', await serviceStore.conversation(groupScope), { background: true, purpose: 'batch', onReply: async () => {} });
    assert.equal(modelNotices.length, 1); assert.equal(group.listen, false);
    assert(!(await service.webAccessRequests.read()).requests.some(item => item.host === 'revoked-group.approval-example.org'));

  } finally { await service.close(); }

  // Notification uses the ordinary delivery entry, text before buttons; target
  // administrator revocation between those submissions prevents the keyboard.
  const sent = [];
  const delivery = { diagnostics: { errorDetails: () => ({}) }, send: async (scope, content, opts) => {
    await opts.beforeSend(); await opts.beforeCommit(); sent.push({ scope, content });
  } };
  const notifications = new AdminNotifications(controller, delivery);
  await notifications.send({ scope: 'group:fixture', reason: 'WEB_DOMAIN_APPROVAL', requestId: 'notice-one', text: 'Host: public.example.org', buttons: notices[0].buttons, beforeSend: options.checkAccess });
  assert.equal(sent.length, 2); assert(sent.every(item => item.scope === 'c2c:fixture-admin'));
  assert.equal(typeof sent[0].content, 'string'); assert(sent[1].content.buttons);
  sent.length = 0;
  delivery.send = async (scope, content, opts) => { await opts.beforeSend(); sent.push({ scope, content }); controller.admins = []; };
  await notifications.send({ scope: 'group:fixture', reason: 'WEB_DOMAIN_APPROVAL', requestId: 'notice-two', text: 'Host: public.example.org', buttons: notices[0].buttons });
  assert.equal(sent.length, 1);
  await assert.rejects(owner.handle('c2c:fixture-admin', '/web-access'), /ADMIN_ACCESS_REVOKED/);
  assert(!JSON.stringify(events).includes('public.example.org'));
  const saved = await readFile(owner.path, 'utf8');
  assert(!saved.includes('fixture-admin')); assert(!saved.includes('https://'));
  console.log('Web approvals: exact-host persistence/revocation, independent-process reads, private administrator commands, expiry/dedup, failure preservation, token/cap checks and guarded notifications, in-gate open/click waits, one-shot POST redirect continuation, approval denial/cancellation/revocation and aggregate wait budgets passed.');
} finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
