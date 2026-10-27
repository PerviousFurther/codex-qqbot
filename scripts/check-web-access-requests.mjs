// Offline approval checkpoints: disposable metadata, local IPC and fake QQ delivery.
import assert from 'node:assert/strict';
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
import { validatePublicURL } from '../lib/public-resource.mjs';
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
    read: async url => validatePublicURL(url),
  }, { scope: 'group:fixture', store: { root, read: async () => ({ allowed: true }) }, stageImages: {},
    webDomains: { check: async () => {}, request: async (value, turnId) => { requestedHost = value; requestedTurn = turnId; return 'pending'; } },
  });
  const failedRead = await endpoints.get('read_webpage')({ url: 'https://blocked.example/private-path?SECRET_QUERY', turn_id: 'tool-turn' });
  assert(failedRead.isError);
  assert.equal(requestedHost, 'blocked.example'); assert.equal(requestedTurn, 'tool-turn');
  assert.equal(JSON.parse(failedRead.content[0].text).code, 'WEB_DOMAIN_NOT_ALLOWED');
  assert.equal(JSON.parse(failedRead.content[1].text).domain_approval, 'pending');
  assert(!JSON.stringify(failedRead).includes('SECRET_QUERY'));


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
  console.log('Web approvals: exact-host persistence/revocation, independent-process reads, private administrator commands, expiry/dedup, failure preservation, token/cap checks and guarded notifications passed.');
} finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
