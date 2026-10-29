import { SnowLumaDrain, MemoryPressure } from '../lib/snowluma-drain.mjs';
import { serveSnowMaintenance, callSnowMaintenance } from '../lib/snowluma-maintenance.mjs';
import { snowGatewayConfig } from '../lib/snowluma-config.mjs';
// Offline regression checks only: temporary state and fake model/QQ transports.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { GroupContext } from '../lib/group-context.mjs';
import { MessageRecords } from '../lib/message-records.mjs';
import { MessageImages } from '../lib/message-images.mjs';
import { GroupAccess } from '../lib/group-access.mjs';
import { ConversationRequests } from '../lib/conversation-requests.mjs';
import { GroupPush } from '../lib/group-push.mjs';
import { GroupSettings } from '../lib/group-settings.mjs';
import { groupPolicy, groupDecision } from '../lib/group-policy.mjs';
import { scopeId } from '../lib/policy.mjs';
import { contextTime } from '../lib/context-time.mjs';
import { registerGroupMemory } from '../lib/group-memory-tools.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';
import { ChatDelivery } from '../lib/chat-delivery.mjs';
import { ChatResponse } from '../lib/chat-response.mjs';
import { DeliveryDiagnostics } from '../lib/delivery-errors.mjs';
import { VideoController } from '../lib/controller.mjs';

const originalAdminIds = process.env.WATCH_ADMIN_IDS;
const root = await mkdtemp(join(tmpdir(), 'watch-group-check-'));
const store = new Store(root); const context = new GroupContext(store);
const images = new MessageImages(store), records = new MessageRecords(store, images);
const appendGroup = async message => {
  message.kind = 'group';
  message.structure = await records.capture(`group:${message.groupOpenid}`, message, null, true);
  return context.append(message);
};
const scope = 'group:fixture'; const id = scopeId(scope);
let closeTools; let controller;
try {
  {
    assert.throws(() => new VideoController({ store, admins: [], claimFirstAdmin: true }), /ADMIN_IDENTITY_REQUIRED/);
    const { assertMessageAccess } = await import('../lib/message-access.mjs');
    const authStore = new Store(join(root, 'explicit-auth'));
    await authStore.write(join(authStore.root, 'admin.json'), { openid: 'former-admin' });
    await authStore.write(join(authStore.root, 'chat-access.json'), { publicPrivateChat: false });
    const previousLegacy = process.env.WATCH_ADMIN_OPENIDS;
    try {
      delete process.env.WATCH_ADMIN_IDS;
      process.env.WATCH_ADMIN_OPENIDS = 'former-admin';
      await assert.rejects(assertMessageAccess('c2c:former-admin', authStore), /PRIVATE_CHAT_DISABLED/);
      process.env.WATCH_ADMIN_IDS = 'current-admin';
      await assertMessageAccess('c2c:current-admin', authStore);
      await assert.rejects(assertMessageAccess('c2c:former-admin', authStore), /PRIVATE_CHAT_DISABLED/);
      assert.deepEqual(await authStore.read(join(authStore.root, 'admin.json')), { openid: 'former-admin' });
    } finally {
      if (previousLegacy === undefined) delete process.env.WATCH_ADMIN_OPENIDS;
      else process.env.WATCH_ADMIN_OPENIDS = previousLegacy;
      if (originalAdminIds === undefined) delete process.env.WATCH_ADMIN_IDS;
      else process.env.WATCH_ADMIN_IDS = originalAdminIds;
    }
  }
  {
let busy = true, paused = false, sealed = false, now = 0;
const d = new SnowLumaDrain({ busy: () => busy, pause: () => paused = true,
 resume: async () => paused = false, seal: async () => sealed = true, now: () => now });
let { token } = await d.command({ action: 'begin' });
assert(paused); assert.equal((await d.command({action:'seal',token})).status,'busy');
await d.arrival(); assert(!paused); assert.equal((await d.command({action:'seal',token})).status,'expired');
({ token } = await d.command({action:'begin'})); busy = false;
assert.equal((await d.command({action:'seal',token})).status,'sealed'); assert(sealed);
now = 120001; await d.expire(); assert(!paused);
const p = new MemoryPressure(); assert(!p.sample(90,0)); assert(!p.sample(84,300000));
assert(!p.sample(90,300001)); assert(p.sample(90,600001)); p.attempted(600001); assert(!p.sample(99,600002));

const socket = join(root, 'maintenance.sock');
const close = await serveSnowMaintenance(socket, d);
try {
 const result = await callSnowMaintenance(socket, {action:'begin'});
 assert.equal(result.status,'draining');
 assert.equal((await callSnowMaintenance(socket,{action:'seal',token:'wrong'})).status,'expired');
 assert.equal((await callSnowMaintenance(socket,{action:'resume',token:result.token})).status,'resumed');
} finally { await close(); }
const config = {networks:{httpServers:[{port:3000,accessToken:'fixture-http'}],wsServers:[{port:3001,accessToken:'fixture-ws'}]},statusCommand:{enabled:true}};
const configured = snowGatewayConfig(config);
assert.equal(configured.config.statusCommand.enabled,false);
assert.equal(configured.config.networks.wsServers[0].messageFormat,'array');
assert.equal(configured.config.networks.httpServers[0].host,'0.0.0.0');
assert.equal(config.statusCommand.enabled,true);
assert.throws(()=>snowGatewayConfig({networks:{httpServers:[],wsServers:[]}}), /AMBIGUOUS/);
  }
  {
    const { SnowLumaChannel } = await import('../lib/snowluma-channel.mjs');
    const { EventEmitter } = await import('node:events');
    class FakeClient {
      events = new EventEmitter(); isConnected = false;
      on(name, listener) { this.events.on(name, listener); return () => this.events.off(name, listener); }
      once(name, listener) { this.events.once(name, listener); return () => this.events.off(name, listener); }
      onEvent(listener) { return this.on('event', listener); }
      async connect() { this.isConnected = true; this.events.emit('open'); }
      async getLoginInfo() { return { user_id: 123456 }; }
      async getGroupList(options) {
        assert.equal(options.noCache, true);
        return [{ group_id: 777777, group_name: 'Synthetic group' }, { group_id: 888888, group_name: 'New group' }];
      }
      close() { if (this.isConnected) { this.isConnected = false; this.events.emit('close'); } }
    }
    const client = new FakeClient(); const delivered = [], queued = [];
    const c = new VideoController({ store: new Store(join(root, 'snow-channel')), admins: ['sl~123456~654321'],
      adapter: { reset: async () => {}, close: async () => {} } });
    const channel = new SnowLumaChannel({account:'123456',wsToken:'fixture',controller:c,client,
      transport:{send:async(target,body,guards)=>{await guards.beforeCommit();guards.onDispatch();delivered.push({target,body});return {id:'1'};}}});
    try {
      const legacy = await c.groupAccess.observe('legacy-openid');
      await c.groupAccess.update(legacy.id, g => { g.allowed = true; g.listen = true; g.push = true; });
      await channel.start(); await channel.activate();
      assert(!c.groupScheduler.entries.has(legacy.id));
      assert(!c.acceptsChannelScope('group:legacy-openid'));
      assert(!c.acceptsChannelScope('c2c:sl~777777~654321'));
      c.requests.enqueue = async value => { queued.push(value); await c.requests.capture(value.who.scope,value.message,value.who.admin); };
      const event = {post_type:'message',message_type:'private',self_id:123456,user_id:654321,message_id:1,time:Date.now()/1000,message:[{type:'text',data:{text:'hello'}}]};
      await channel.receive(event); await channel.receive(event);
      assert.equal(queued.length,1); assert(queued[0].who.admin);
      assert.equal((await c.replyContacts.records())[0].openid,'sl~123456~654321');
      await channel.receive({...event,message_id:2,self_id:777777}); assert.equal(queued.length,1);
      await channel.receive({...event,message_id:2,user_id:123456}); assert.equal(queued.length,1);
      await channel.receive({...event,message_id:3,message:[{type:'text',data:{text:'/unknown-fixture'}}]});
      assert.equal(queued.length,1); assert(delivered.length > 0);
      const group = await c.groupAccess.observe('sl~123456~777777');
      await c.groupAccess.update(group.id,g=>{g.allowed=true;g.listen=true;g.engage=false;});
      await channel.receive({...event,message_type:'group',group_id:777777,message_id:4});
      assert(await c.messageRecords.find('group:sl~123456~777777','slmsg~4')); assert.equal(queued.length,1);
      // Events admitted by an old connection must not enter a new model turn
      // after an asynchronous drain or capture boundary, even after reconnect.
      for (const boundary of ['drain', 'capture']) {
        const owner = boundary === 'drain' ? channel.drain : c.groupRuntime;
        const method = boundary === 'drain' ? 'arrival' : 'observe';
        const original = owner[method];
        let release, entered;
        const paused = new Promise(resolve => { entered = resolve; });
        owner[method] = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
        const count = queued.length;
        const pending = channel.receive({ ...event, message_id: boundary === 'drain' ? 20 : 21 });
        await paused;
        client.close(); await channel.resetting;
        await channel.start();
        release(); await pending;
        owner[method] = original;
        assert.equal(queued.length, count);
      }
      // Exercise operator entry points through the authenticated new channel.
      c.adapter.models = async () => [{ id: 'fixture', name: 'Fixture', isDefault: true,
        efforts: [{ id: 'low' }], defaultEffort: 'low' }];
      const queuedBeforeMenus = queued.length;
      let menuId = 100;
      for (const command of ['/help', '/status', '/settings', '/settings chat', '/settings data',
        '/settings display', '/settings browsing', '/preferences', '/persona', '/models', '/thinking',
        '/groups', `/group view ${group.id}`, '/memory', '/files', '/media', '/contents',
        '/history', '/context-sharing', '/web-access', '/debug']) {
        const before = delivered.length;
        await channel.receive({ ...event, message_id: menuId++, message: [{ type: 'text', data: { text: command } }] });
        const replies = delivered.slice(before);
        assert(replies.length > 0, command);
        assert(replies.every(item => item.target.targetId === 'sl~123456~654321'), command);
        assert(replies.some(item => item.body.text || item.body.file), command);
        assert(!replies.some(item => item.body.text?.includes('服务提醒')), command);
        if (command === '/debug') assert(replies.some(item => item.body.file?.name.endsWith('.txt')));
      }
      assert.equal(queued.length, queuedBeforeMenus);
      for (const type of ['image', 'record', 'video', 'file']) {
        await channel.receive({ ...event, message_id: menuId++, message: [{ type, data: { name: 'fixture' } }] });
        assert.equal(queued.at(-1).message.attachments.length, 1);
        assert(queued.at(-1).message.structure);
      }
      assert.equal(queued.length, queuedBeforeMenus + 4);
      const groupBeforeRefresh = await c.groupAccess.read(group.id);
      const menu = await c.groupSettings.menu();
      assert(menu.text.includes('Synthetic group（群号：777777）'));
      assert(menu.text.includes('New group（群号：888888）'));
      assert(!menu.buttons.rows.flat().some(item => item.command.includes(legacy.id)));
      const discovered = await c.groupAccess.read(scopeId('group:sl~123456~888888'));
      assert.equal(discovered.allowed, false); assert.equal(discovered.listen, false); assert.equal(discovered.push, false);
      assert.deepEqual(await c.groupAccess.read(group.id), groupBeforeRefresh);
      assert.equal((await c.groupAccess.read(legacy.id)).allowed, true);
      await c.groupAccess.membership('sl~123456~888888', false, Date.now());
      await c.groupSettings.menu();
      assert.equal(await c.groupAccess.read(discovered.id), null);
      const getGroups = client.getGroupList;
      client.getGroupList = async () => { throw new Error('PRIVATE_UPSTREAM_ERROR'); };
      const cachedMenu = await c.groupSettings.menu();
      assert(cachedMenu.text.includes('刷新失败')); assert(cachedMenu.text.includes('777777'));
      assert(!cachedMenu.text.includes('PRIVATE_UPSTREAM_ERROR'));
      client.getGroupList = async () => {
        client.close(); await channel.resetting; await channel.start();
        return [{ group_id: 999999, group_name: 'Stale response' }];
      };
      assert((await c.groupSettings.menu()).text.includes('刷新失败'));
      assert.equal(await c.groupAccess.read(scopeId('group:sl~123456~999999')), null);
      client.getGroupList = getGroups;
      const numbered = await c.commandSelections.prepare('c2c:sl~123456~654321', {
        rows: [[{ label: '查看本群', command: `/group view ${group.id}` }]] });
      const selection = numbered.rows[0][0].command;
      const beforeSelection = delivered.length;
      await channel.receive({ ...event, message_id: menuId++, message: [{ type: 'text', data: { text: selection } }] });
      const selectionReplies = delivered.slice(beforeSelection);
      assert(selectionReplies.some(item => item.body.text.includes('Synthetic group')));
      const actions = selectionReplies.flatMap(item => item.body.buttons?.rows.flat() ?? []);
      assert(actions.some(item => item.command.startsWith('/操作 ')));
      assert(actions.every(item => !item.command.includes(group.id)));
      assert.equal(queued.length, queuedBeforeMenus + 4);
      // QQ group administrators do not acquire private bot-management rights.
      const beforeDenied = delivered.length;
      await channel.receive({ ...event, message_type: 'group', group_id: 777777, message_id: menuId++,
        sender: { role: 'owner' }, message: [{ type: 'text', data: { text: '/settings' } }] });
      assert(delivered.slice(beforeDenied).some(item => item.body.text === '这个请求无法在当前对话中处理。'));
      assert.equal(queued.length, queuedBeforeMenus + 4);
      let notices=0; c.groupLifecycle.handle=async value=>{notices++;assert.equal(value.groupId,'sl~123456~777777');assert.equal(value.at,1000);};
      await channel.receive({self_id:123456,post_type:'notice',notice_type:'group_decrease',group_id:777777,user_id:654321,time:1});
      assert.equal(notices,0);
      await channel.receive({self_id:123456,post_type:'notice',notice_type:'group_decrease',group_id:777777,user_id:123456,time:1});assert.equal(notices,1);
      const route=await c.replyRouting.session('c2c:sl~123456~654321','fixture',()=>true);
      assert(!route.targets.some(t=>t.id===`group:${legacy.id}`));
      const targets = await c.taskControls.targets('c2c:sl~123456~654321');
      assert(!targets.some(target => target.id === legacy.id));
      const shared = await c.chatContext.session('c2c:sl~123456~654321', async () => {})({ operation: 'list', offset: 0, limit: 20 });
      assert.equal(shared.items.length, 1);
      assert.equal(shared.items[0].label, 'Synthetic group');
      const { diagnosticReport } = await import('../lib/diagnostic-report.mjs');
      const report = await diagnosticReport(c, 'c2c:sl~123456~654321');
      assert(!report.file.text.includes(legacy.id));

      await Promise.allSettled([...channel.pending]);
      const {token}=await channel.drain.command({action:'begin'});
      assert.equal((await channel.drain.command({action:'seal',token})).status,'sealed');
      assert(!channel.ready); assert(c.draining);
      await channel.drain.command({action:'resume',token});assert(channel.ready);assert(!c.draining);
      assert.equal((await c.groupAccess.read(legacy.id)).push,true);
    } finally { const stopped=channel.stop(); await c.close(); await stopped; }
  }

  const now = Date.now();
  const group = { id, openid: 'fixture', allowed: true, listen: true, engage: true, observedAt: new Date(now).toISOString() };
  const status = { pendingCount: 1, pendingChars: 1, firstPendingAt: now - 600000,
    lastMessageAt: now - 10000, lastBatchAt: now, retryAt: 0, idleReserved: 0 };
  assert.equal(groupDecision(group, status, now).due, now + 170000);
  assert.equal(groupDecision(group, { ...status, lastMessageAt: now }, now).due, now + 180000);
  assert.equal(groupDecision(group, { ...status, lastMessageAt: now - 180000 }, now).due, now);
  assert.equal(groupDecision(group, { ...status, pendingCount: 20 }, now).due, now);
  assert.equal(groupDecision(group, { ...status, pendingChars: 1000 }, now).due, now);
  assert.equal(groupDecision({ ...group, schedule: { minIntervalSeconds: 3600 } }, { ...status, pendingCount: 20 }, now).due, now);
  assert.equal(groupDecision(group, { ...status, pendingCount: 20, retryAt: now + 5000 }, now).due, now + 5000);
  assert.deepEqual(groupDecision(group, { ...status, pendingMentions: 1 }, now),
    { ...groupDecision(group, status, now), due: now, reason: 'mention' });
  assert.equal(groupDecision(group, { ...status, pendingMentions: 1, retryAt: now + 5000 }, now).due, now + 5000);
  assert.equal(groupDecision({ ...group, taskBlocked: 'SEND_FAILED' }, { ...status, pendingMentions: 1 }, now).due, null);
  assert.equal(groupDecision({ ...group, listen: false }, { ...status, pendingMentions: 1 }, now).due, null);
  assert.equal(groupPolicy(group).contextMinutes, 10);

  assert.equal(contextTime('2026-10-25T04:09:37Z'), '26/10/25-12:09');
  assert.equal(contextTime('2026-12-31T16:05:00Z'), '27/01/01-00:05');

  for (const [messageId, ago, senderId] of [['old', 660000, 'old-member'], ['recent', 300000, 'member'], ['latest', 1000, 'member']]) {
    await appendGroup({ groupOpenid: 'fixture', senderId, messageId, content: messageId,
      senderName: senderId, botMentioned: messageId !== 'recent', timestamp: new Date(now - ago).toISOString() });
  }
  assert.equal((await context.batchStatus(scope)).pendingMentions, 1);
  assert.deepEqual((await context.snapshot(scope)).messages, []);
  let snapshot = await context.snapshot(scope, { batch: true });
  assert.deepEqual(snapshot.messages.map(row => row.messageId), ['recent', 'latest']);
  assert.deepEqual(snapshot.participants.map(row => row.openid), ['member']);
  assert(snapshot.messages.every(row => !('isBotAdmin' in row)));
  assert.equal(snapshot.timezone, 'Asia/Shanghai');
  snapshot = await context.snapshot(scope, { contextMinutes: 1, batch: true });
  assert.deepEqual(snapshot.messages.map(row => row.messageId), ['latest']);
  await context.markSupplied(scope, ['recent', 'latest'], snapshot.epoch);
  await context.acknowledgeBatch(scope, snapshot.latestRevision, snapshot.epoch);
  assert.equal((await context.batchStatus(scope)).pendingCount, 0);
  assert.equal((await context.batchStatus(scope)).pendingMentions, 0);
  assert.equal((await context.recall(scope, { since: new Date(now - 900000).toISOString() })).messages.length, 3);
  const prefix = await context.recall(scope, { for_compaction: true });
  await context.compact(scope, prefix.receipt, 'old topic');
  assert.equal((await context.snapshot(scope)).summary, undefined);
  assert.equal((await context.recall(scope)).summary, undefined);

  await store.write(join(root, 'groups', `${id}.json`), group);
  const tools = new Map();
  closeTools = registerGroupMemory((name, _description, _schema, action) => tools.set(name, action), scope, store);
  const recalled = (await tools.get('recall_group_context')({}))[0].single();
  assert.deepEqual(recalled.messages.map(row => row.messageId), ['recent', 'latest']);
  const older = (await tools.get('recall_group_context')({ since: new Date(now - 900000).toISOString() }))[0].single();
  assert.equal(older.messages.length, 3);

  // Notification options must not resume a stopped group or release another sender's reservation.
  const stopped = { ...group, taskBlocked: 'SEND_FAILED', pushPending: true, pushOwner: 'existing' };
  const settings = new GroupSettings({ groups: { read: async () => stopped, update: async (_id, change) => { await change(stopped); return stopped; } }, changed: async () => {} });
  assert(!JSON.stringify(settings.more(stopped)).includes('回复额度提醒'));
  await settings.handle(`/group tool-monitor-on ${id}`, 'c2c:admin');
  assert.equal(stopped.toolMonitor, true);
  await settings.handle(`/group tool-monitor-off ${id}`, 'c2c:admin');
  assert.equal(stopped.toolMonitor, false);
  assert.equal(stopped.taskBlocked, 'SEND_FAILED');
  assert.equal(stopped.pushOwner, 'existing');
  assert(!settings.schedule(group).buttons.rows.flat().some(button => button.command.includes('interval')));

  // Group progress and tool events go to the shared administrator notifier;
  // only substantive answers use the group sender/reservation path.
  const progressLane = { tail: Promise.resolve(), epoch: 0, pending: 0, active: null, failures: 0, interruptedWork: [] };
  const progressMessages = []; const progressEvents = []; const feedback = [];
  let progressSender; let progressRuns = 0; let progressDeliveries = 0; let silent = false;
  const progressGroups = new GroupAccess(store);
  const progressPush = new GroupPush(progressGroups, context, async (_openid, text, options) => {
    await options.beforeSend(); progressMessages.push(text);
  }, () => 'failed', (state, details) => progressEvents.push({ state, ...details }));
  const progressTasks = new ConversationRequests({ groupAccess: progressGroups, groupContext: context, store, lane: () => progressLane,
    foregroundPending: () => false, closed: false, debug: { record() {} }, reportTaskFailure: async () => {},
    notifyAdmins: async report => feedback.push(report),
    groupPublisher: { replies: (...args) => progressSender = progressPush.replies(...args), deliver: async () => { progressDeliveries++; return false; } },
    run: async (_scope, _text, _checkpoint, options) => {
      progressRuns++;
      options.onUpdate({ kind: 'tool', name: 'get_webpage_subtitles', arguments: 'PARAMETER_SENTINEL' });
      options.onUpdate({ kind: 'tool', name: 'get_webpage_subtitles' });
      options.onUpdate({ kind: 'tool-result', name: 'get_webpage_subtitles', status: 'completed', elapsedMs: 1250, result: 'BODY_SENTINEL' });
      options.onUpdate({ kind: 'explanation', text: 'COMMENTARY_SENTINEL' });
      options.onUpdate({ kind: 'answer' });
      if (!silent && options.onReply) await options.onReply('substantive answer', () => true);
      return { replyAttempted: !silent && options.onReply ? 1 : 0, groupRevision: 0,
        groupEpoch: (await context.batchStatus(scope)).epoch, startedAt: new Date().toISOString() };
    } });
  const progressTrigger = { kind: 'batch', reason: 'mention', status: await context.batchStatus(scope) };
  const saveProgressGroup = value => store.write(progressGroups.path(id), { ...group, ...value });
  await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  assert.equal(feedback.length, 5); assert.equal(progressSender.sent, 1);
  assert(!feedback.some(report => report.text.includes('正在准备回复')));
  assert.deepEqual(progressMessages, ['substantive answer']);
  const beforeMonitor = feedback.length;
  await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  const monitored = feedback.slice(beforeMonitor);
  assert.equal(monitored.length, 5);
  assert.equal(monitored.filter(report => report.text === '开始读取网页字幕。').length, 2);
  assert(monitored.some(report => report.text.includes('已完成（用时 1.3 秒）')));
  assert(monitored.every(report => report.scope === scope && report.reason === 'TASK_FEEDBACK'));
  assert(!JSON.stringify(monitored).includes('SENTINEL'));
  assert(progressMessages.every(text => text === 'substantive answer'));
  const beforeDisabled = feedback.length;
  await saveProgressGroup({ toolMonitor: false }); await progressTasks.process(group, progressTrigger);
  assert.equal(feedback.length, beforeDisabled);
  silent = true; await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  assert.equal(progressSender.sent, 0); assert.equal(progressDeliveries, 0);
  const beforeCollectionOnly = feedback.length;
  await saveProgressGroup({ toolMonitor: true, engage: false }); await progressTasks.process(group, progressTrigger);
  assert.equal(feedback.length, beforeCollectionOnly);
  const beforePause = progressRuns;
  await saveProgressGroup({ toolMonitor: true, taskBlocked: 'SEND_FAILED' }); await progressTasks.process(group, progressTrigger);
  assert.equal(progressRuns, beforePause);
  // Notification failure never becomes a failed group sender or swallows answers.
  silent = false; progressTasks.controller.notifyAdmins = async () => { throw new Error('NOTICE_SEND_FAILED'); };
  await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  assert.equal(progressSender.failed, false); assert.equal(progressSender.sent, 1);
  assert.equal(progressMessages.at(-1), 'substantive answer');
  await saveProgressGroup({});

  const sent = []; const debug = { record() {} };
  const noticeController = { admins: ['admin'], debug, groupAccess: { read: async () => group } };
  const delivery = new ChatDelivery({ diagnostics: new DeliveryDiagnostics(), onState() {},
    assertCanContinue: async () => {}, transport: async (target, { text }, { beforeCommit }) => {
      await beforeCommit();
      if (text === 'limited') throw Object.assign(new Error('QQ_RATE_LIMITED'), { httpStatus: 429 });
      sent.push({ target, text }); return {};
    }, notifyAdmins: report => notices.send(report) });
  const notices = new AdminNotifications(noticeController, delivery);
  const response = new ChatResponse({ message: { kind: 'group', groupOpenid: 'fixture', requestId: 'request',
    replyTarget: { scope: 'group', targetId: 'fixture', msgId: 'incoming' } }, delivery, debug, onState() {} });
  for (let i = 0; i < 6; i++) await response.send({ event: 'reply-part', text: `part ${i}` });
  assert.equal(sent.filter(row => row.target.scope === 'group').length, 6);
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 0);
  assert.equal(sent.filter(row => row.target.scope === 'group').at(-1).target.msgId, 'incoming');
  // A typed rejection notifies administrators without blocking subsequent sends.
  let timer;
  try {
    await Promise.race([
      assert.rejects(delivery.send(scope, 'limited'), /QQ_RATE_LIMITED/),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('notification deadlock')), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 1);
  await assert.rejects(delivery.send(scope, 'limited', { isActive: () => true, beforeSend: async () => {} }), /QQ_RATE_LIMITED/);
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 2);

  const privateResponse = new ChatResponse({ message: { kind: 'c2c', senderId: 'user', requestId: 'private-request',
    replyTarget: { scope: 'c2c', targetId: 'user', msgId: 'private-incoming' } }, delivery, debug, onState() {} });
  for (let i = 0; i < 5; i++) await privateResponse.send({ event: 'reply-part', text: `private ${i}` });
  assert.equal(sent.filter(row => row.target.targetId === 'user' && row.target.msgId).length, 5);
  assert.equal(sent.filter(row => row.target.targetId === 'admin').length, 2);

  // Expired group threads are detached, while live threads and private threads are reused.
  let resets = 0; let calls = 0;
  const adapter = { reset: async () => { resets++; }, run: async options => {
    calls++; assert.equal(options.groupContext, null); await options.onCheckpoint({ threadId: `thread-${calls}` });
    await options.onInputAccepted();
    return { sharedState: null };
  }, compact: async () => true };
  controller = new VideoController({ adapter, store, admins: ['admin'] });
  // Membership evidence is channel-neutral; departure wins equal timestamps,
  // delayed joins cannot restore grants, and official payloads are not decoded.
  const memberScope = 'group:membership-fixture'; const memberId = scopeId(memberScope);
  await controller.groupLifecycle.handle({ eventType: 'GROUP_ADD_ROBOT', data: { group_openid: 'membership-fixture' }, receivedAt: now });
  assert.equal(await controller.groupAccess.read(memberId), null);
  await controller.groupLifecycle.handle({ groupId: 'membership-fixture', joined: true, at: now });
  assert.equal((await controller.groupAccess.read(memberId)).allowed, false);
  await controller.groupAccess.update(memberId, value => { value.allowed = true; value.listen = true; });
  await controller.groupLifecycle.handle({ groupId: 'membership-fixture', joined: false, at: now + 100 });
  const departed = await store.read(controller.groupAccess.path(memberId), null);
  assert.equal(departed.allowed, false); assert.equal(departed.cleanupPending, false);
  await controller.groupLifecycle.handle({ groupId: 'membership-fixture', joined: true, at: now + 100 });
  assert.equal(await controller.groupAccess.read(memberId), null);
  assert.equal((await store.read(controller.groupAccess.path(memberId), null)).leftAt, departed.leftAt);
  await controller.groupLifecycle.handle({ groupId: 'membership-fixture', joined: true, at: now + 101 });
  assert.equal((await controller.groupAccess.read(memberId)).allowed, false);
  resets = 0; // Isolate subsequent model-thread checks from departure cleanup.
  // Even a direct handler caller cannot restore the old group foreground path.
  const groupMessage = { kind: 'group', groupOpenid: 'fixture', senderId: 'member', messageId: 'direct-group', content: 'hello' };
  let commandReplies = 0;
  await controller.messages.handle(groupMessage, async () => { commandReplies++; });
  assert.equal(calls, 0); assert.equal(commandReplies, 0);
  await controller.messages.handle({ ...groupMessage, messageId: 'direct-command', content: '/help' }, async () => { commandReplies++; });
  assert.equal(calls, 0); assert.equal(commandReplies, 1);
  await assert.rejects(controller.requests.enqueue({ who: { scope, private: false } }), /FOREGROUND_PRIVATE_REQUIRED/);
  const checkpoint = { threadId: 'old-thread', model: 'fixture-model', seen: ['seen'], reasoningEffort: 'low' };
  await controller.run(scope, 'fixture request', checkpoint);
  assert.equal(resets, 1);
  assert.equal(checkpoint.model, 'fixture-model'); assert.deepEqual(checkpoint.seen, ['seen']);
  await controller.run(scope, 'fixture request', checkpoint);
  assert.equal(resets, 1);
  checkpoint.groupContextExpiresAt = Date.now() - 1;
  await controller.run(scope, 'fixture request', checkpoint);
  assert.equal(resets, 2);
  const privateCheckpoint = { threadId: 'private-thread', seen: [] };
  await controller.run('c2c:admin', 'fixture request', privateCheckpoint);
  assert.equal(resets, 2);
  assert.equal(calls, 4);
  // Long ordinary private input uses the same record projection as short input.
  process.env.WATCH_ADMIN_IDS = 'admin';
  controller.reportTaskFailure = async (_scope, error) => { throw error; };
  await controller.messages.handle({ kind: 'c2c', senderId: 'admin', messageId: 'long-private',
    content: 'x'.repeat(20000), timestamp: new Date().toISOString() }, async () => {});
  assert.equal(calls, 5);
  assert.equal((await controller.messageRecords.find('c2c:admin', 'long-private')).components[0].text.length, 20000);
  // Unsupported detail blobs cannot break retained-original recall or batches.
  const formatScope = 'group:format-fixture';
  await appendGroup({ groupOpenid: 'format-fixture', senderId: 'fixture', messageId: 'retained-original',
    content: 'retained original text', timestamp: new Date().toISOString() });
  const formatDb = await context.database(formatScope);
  formatDb.prepare('INSERT OR REPLACE INTO message_details(message_id,body) VALUES(?,?)')
    .run('retained-original', JSON.stringify({ text: 'unsupported detail', attachments: [] }));
  const recalledOriginals = await context.recall(formatScope, {});
  assert.equal(recalledOriginals.messages[0].text, 'retained original text');
  assert.equal(recalledOriginals.messages[0].message, null);
  assert(!JSON.stringify(recalledOriginals).includes('unsupported detail'));
  assert.equal((await context.snapshot(formatScope, { batch: true })).messages.length, 1);

  console.log('Offline group checks passed: trigger alternatives, time filtering/cursors, settings, notification delivery and thread expiry.');
} finally {
  if (originalAdminIds === undefined) delete process.env.WATCH_ADMIN_IDS;
  else process.env.WATCH_ADMIN_IDS = originalAdminIds;
  await closeTools?.();
  await controller?.groupContext.close();
  await context.close();
  await records.close(); await images.close();
  await rm(root, { recursive: true, force: true });
}
