// Offline: disposable records, local IPC, fake inference and no QQ/media I/O.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { registerChatContextTools } from '../lib/tools/chat-context.mjs';
import { toolRegistrar } from '../lib/tools/register.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-chat-context-'));
const store = new Store(root); let controller; let bridge;
const request = (operation, extra = {}) => ({ operation, offset: 0, limit: 20, ...extra });
const message = (kind, id, content) => ({ kind, senderId: kind === 'group' ? 'SPEAKER_ID_SENTINEL' : id,
  senderName: 'PRIVATE_NAME_SENTINEL', groupOpenid: kind === 'group' ? id : undefined,
  messageId: randomUUID(), timestamp: new Date().toISOString(), content, images: [] });
try {
  let inspectRun;
  controller = new VideoController({ store, admins: ['operator'], adapter: {
    reset: async () => {}, close: async () => {}, run: async options => { await inspectRun(options); return { sharedState: null }; },
  } });
  for (const [name, flags] of [['source', {}], ['target', {}], ['denied', { allowed: false }], ['stopped', { taskBlocked: 'ADMIN_STOPPED' }], ['uncollected', { listen: false }]]) {
    await store.write(controller.groupAccess.path(scopeId(`group:${name}`)), {
      id: scopeId(`group:${name}`), openid: name, name: `Fixture ${name}`, allowed: true, listen: true, engage: true,
      observedAt: new Date().toISOString(), ...flags,
    });
  }
  const groupMessage = message('group', 'target', 'shared group text');
  await controller.messageRecords.capture('group:target', groupMessage, null, true);
  await controller.groupContext.append(groupMessage);
  const batchBefore = await controller.groupContext.batchStatus('group:target');
  const privateMessage = message('c2c', 'person', 'PRIVATE_TEXT_FIXTURE');
  await controller.replyContacts.observe(privateMessage);
  await controller.messageRecords.capture('c2c:person', privateMessage, false);
  const source = 'group:source'; let active = true;
  const check = async () => { if (!active) throw new Error('CONTEXT_SOURCE_UNAVAILABLE'); };
  const reader = controller.chatContext.session(source, check);
  let directory = await reader(request('list'));
  assert.equal(directory.items.length, 1); assert.equal(directory.items[0].kind, 'group');
  const target = directory.items[0].id;
  const groupPage = await reader(request('read', { target, query: 'group' }));
  assert.equal(groupPage.items[0].components[0].text, 'shared group text');
  assert(groupPage.items[0].speaker.alias.startsWith('speaker:'));
  assert(!JSON.stringify(groupPage).includes('SPEAKER_ID_SENTINEL'));
  assert(!JSON.stringify(groupPage).includes('PRIVATE_NAME_SENTINEL'));
  assert(!JSON.stringify(groupPage).includes(groupMessage.messageId));
  assert.equal((await reader(request('read', { target, query: 'no-match' }))).items.length, 0);
  await assert.rejects(reader(request('read', { target: 'group:target' })), /CONTEXT_TARGET_UNAVAILABLE/);
  await assert.rejects(reader(request('read', { target, since: 'invalid' })), /CONTEXT_QUERY_INVALID/);
  assert.deepEqual(await controller.groupContext.batchStatus('group:target'), batchBefore);
  // Private sharing is self-service and off by default; group callers cannot toggle it.
  const who = { scope: 'c2c:person', private: true, admin: false };
  assert.equal((await controller.adminSettings.read(who.scope)).shareContext, false);
  await controller.chatContext.sharing({ scope: source, private: false }, '/context-sharing on');
  assert.equal((await controller.adminSettings.read(who.scope)).shareContext, false);
  const replies = [];
  await controller.commands.dispatch({ who, text: '/context-sharing on', reply: async value => replies.push(value) });
  assert.equal(replies.length, 1); assert(replies[0].text.includes('包括群聊'));
  await controller.adminSettings.update(who.scope, settings => { settings.toolMonitor = true; });
  assert.equal((await controller.adminSettings.read(who.scope)).shareContext, true);
  directory = await reader(request('list'));
  const privateTarget = directory.items.find(row => row.kind === 'private').id;
  assert.equal((await reader(request('read', { target: privateTarget }))).items[0].components[0].text, 'PRIVATE_TEXT_FIXTURE');
  await controller.chatContext.sharing(who, '/context-sharing off');
  await assert.rejects(reader(request('read', { target: privateTarget })), /CONTEXT_NOT_SHARED/);
  await controller.chatContext.sharing(who, '/context-sharing on');
  await assert.rejects(reader(request('read', { target: privateTarget })), /CONTEXT_NOT_SHARED/);
  assert.notEqual((await reader(request('list'))).items.find(row => row.kind === 'private').id, privateTarget);
  // New turn aliases cannot reuse another turn's grants.
  const other = controller.chatContext.session('c2c:operator', check);
  await assert.rejects(other(request('read', { target })), /CONTEXT_TARGET_UNAVAILABLE/);
  // Live revocation and post-acquisition checks discard buffered text.
  const originalPage = controller.messageRecords.contextPage.bind(controller.messageRecords);
  controller.messageRecords.contextPage = async (...args) => {
    const page = await originalPage(...args);
    await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = false; });
    return page;
  };
  await assert.rejects(reader(request('read', { target })), /CONTEXT_TARGET_UNAVAILABLE/);
  controller.messageRecords.contextPage = originalPage;
  await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = true; });
  controller.lane('group:target').epoch++;
  await assert.rejects(reader(request('read', { target })), /CONTEXT_TARGET_UNAVAILABLE/);
  active = false;
  await assert.rejects(reader(request('list')), /CONTEXT_SOURCE_UNAVAILABLE/); active = true;
  // Actual MCP encoding and local turn-token IPC, with no model connection.
  bridge = await ReplyBridge.open();
  const turnId = randomUUID(); const session = controller.chatContext.session(source, check);
  const binding = bridge.bind({ id: turnId, chatContext: session });
  const tools = new Map();
  registerChatContextTools(toolRegistrar({ registerTool(name, options, action) { tools.set(name, { options, action }); } }, toolPolicy()), bridge.path);
  const listed = await tools.get('list_context_chats').action({ turn_id: turnId, offset: 0, limit: 20 });
  assert(!listed.isError);
  const alias = JSON.parse(listed.content[0].text).items.find(row => row.kind === 'group').id;
  const read = await tools.get('read_chat_context').action({ turn_id: turnId, target: alias, query: '', since: '', until: '', offset: 0, limit: 20 });
  assert(!read.isError); assert(JSON.stringify(read).includes('shared group text'));
  assert.equal((await callReplyBridge(bridge.path, { action: 'chat_context', turn_id: randomUUID(), ...request('list') })).code, 'REPLY_TURN_EXPIRED');
  await binding.close();
  const discovery = bridge.bind({ id: randomUUID() });
  assert.throws(() => bridge.dispatch({ turn_id: discovery.turn.id, action: 'chat_context', ...request('list') }), /TURN_ACTION_NOT_ALLOWED/);
  await discovery.close();
  // Controller only supplies the capability to authorized foreground/batch turns.
  inspectRun = async options => { assert.equal(typeof options.onChatContext, 'function'); await options.onChatContext(request('list')); };
  await controller.run('c2c:operator', 'fixture', {}, { onReply: async () => {} });
  inspectRun = async options => {
    assert.equal(typeof options.onChatContext, 'function');
    await controller.groupAccess.update(scopeId(source), row => { row.engage = false; });
    await assert.rejects(options.onChatContext(request('list')), /CONTEXT_SOURCE_UNAVAILABLE/);
  };
  await controller.run(source, 'fixture', {}, { background: true, purpose: 'batch', onReply: async () => {} });
  await controller.groupAccess.update(scopeId(source), row => { row.engage = true; });
  inspectRun = async options => { assert.equal(options.onChatContext, undefined); };
  await controller.run('c2c:operator', 'fixture', {}, { background: true, purpose: 'discover' });
  await controller.run(source, 'fixture', {}, { background: true, purpose: 'warmup', onReply: async () => {} });
  // Text budgets paginate instead of expanding media/forwarded components.
  for (let i = 0; i < 15; i++) await controller.messageRecords.capture('c2c:person', message('c2c', 'person', 'x'.repeat(1200)), false);
  const bounded = await controller.messageRecords.contextPage('c2c:person', {});
  assert(bounded.items.length < 15); assert(bounded.nextOffset > 0);
  assert(JSON.stringify(bounded).length < 12500);
  const next = await controller.messageRecords.contextPage('c2c:person', { offset: bounded.nextOffset });
  assert(next.items.length > 0); assert(!bounded.items.some(row => next.items.some(other => other.id === row.id)));
  await controller.replyContacts.block('c2c:person');
  assert(!(await session(request('list'))).items.some(row => row.kind === 'private'));
  await controller.replyContacts.observe(privateMessage);
  const readerForFailure = controller.chatContext.session(source, check, 'fixture-failure');
  const failureAlias = (await readerForFailure(request('list'))).items.find(row => row.kind === 'group').id;
  const notifications = []; controller.notifyAdmins = async report => notifications.push(report);
  controller.messageRecords.contextPage = async () => { throw new Error('PRIVATE_DATABASE_BODY_SENTINEL'); };
  await assert.rejects(readerForFailure(request('read', { target: failureAlias })), /CHAT_CONTEXT_FAILED/);
  assert.equal(notifications[0].reason, 'CHAT_CONTEXT_FAILED');
  assert.equal(controller.debug.read(source).counters.chat_context_failed, 1);
  assert(!JSON.stringify(controller.debug.read(source)).includes('PRIVATE_DATABASE_BODY_SENTINEL'));
  controller.messageRecords.contextPage = originalPage;
  const persisted = await controller.adminSettings.read('c2c:person');
  const restarted = new (controller.adminSettings.constructor)(store);
  assert.deepEqual(await restarted.read('c2c:person'), persisted);
  assert(!JSON.stringify(controller.debug.read(source)).includes('PRIVATE_TEXT_FIXTURE'));
  console.log('Offline cross-chat context checks passed: opt-in sharing, source/target revocation, scoped aliases, text-only IPC, unchanged receipts and discovery exclusion.');
} finally { await bridge?.close(); await controller?.close(); await rm(root, { recursive: true, force: true }); }
