// Offline regression checks only: temporary state and fake model/QQ transports.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { GroupContext } from '../lib/group-context.mjs';
import { GroupAccess } from '../lib/group-access.mjs';
import { GroupTasks } from '../lib/group-tasks.mjs';
import { GroupPush } from '../lib/group-push.mjs';
import { GroupSettings } from '../lib/group-settings.mjs';
import { groupPolicy, groupDecision } from '../lib/group-policy.mjs';
import { scopeId } from '../lib/policy.mjs';
import { contextTime } from '../lib/context-time.mjs';
import { registerGroupMemory } from '../lib/group-memory-tools.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';
import { QQChannel } from '../lib/qq-channel.mjs';
import { QQDelivery } from '../lib/qq-delivery.mjs';
import { QQResponse } from '../lib/qq-response.mjs';
import { QQDiagnostics } from '../lib/qq-diagnostics.mjs';
import { SerialQueue } from '../lib/serial-queue.mjs';
import { VideoController } from '../lib/controller.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-group-check-'));
const store = new Store(root); const context = new GroupContext(store);
const scope = 'group:fixture'; const id = scopeId(scope);
let closeTools; let controller;
try {
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

  // Exercise the actual channel middleware offline: mentions join collection,
  // commands still reach dispatch, and private chat keeps its foreground path.
  const observed = []; const foreground = [];
  const channel = new QQChannel({ appId: 'fixture-bot', appSecret: 'fixture-secret', menuEnabled: false,
    controller: { debug: { record() {} }, groupRuntime: { observe: async message => observed.push({ ...message }) } } });
  const receive = async message => {
    const ctx = { message, bot: channel.bot, state: {}, log: {}, stop(reason) { this.stopped = true; this.stopReason = reason; } };
    const chain = channel.bot.getMiddlewares();
    const next = async index => { if (index === chain.length) foreground.push(message); else await chain[index](ctx, () => next(index + 1)); };
    await next(0); return ctx;
  };
  await receive({ kind: 'group', groupOpenid: 'fixture', messageId: 'ordinary', content: 'hello' });
  await receive({ kind: 'group', groupOpenid: 'fixture', messageId: 'at-event', content: 'question', rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
  await receive({ kind: 'group', groupOpenid: 'fixture', messageId: 'at-text', content: '<@fixture-bot> question' });
  await receive({ kind: 'group', groupOpenid: 'fixture', messageId: 'at-other', content: 'hello', mentions: [{ id: 'other' }] });
  assert.equal(foreground.length, 0);
  assert.deepEqual(observed.map(row => row.botMentioned), [false, true, true, false]);
  assert.equal(observed[2].content, 'question');
  await receive({ kind: 'group', groupOpenid: 'fixture', messageId: 'command', content: '<@fixture-bot> /settings' });
  await receive({ kind: 'c2c', senderId: 'admin', messageId: 'private', content: 'hello' });
  assert.deepEqual(foreground.map(row => row.messageId), ['command', 'private']);
  assert.equal(contextTime('2026-10-25T04:09:37Z'), '26/10/25-12:09');
  assert.equal(contextTime('2026-12-31T16:05:00Z'), '27/01/01-00:05');

  for (const [messageId, ago, senderId] of [['old', 660000, 'old-member'], ['recent', 300000, 'member'], ['latest', 1000, 'member']]) {
    await context.append({ groupOpenid: 'fixture', senderId, messageId, content: messageId,
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
  await settings.handle(`/group limit-notify-on ${id}`, 'c2c:admin');
  assert.equal(stopped.notifyReplyLimit, true);
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
  const progressTasks = new GroupTasks({ groups: progressGroups, context, store, lane: () => progressLane,
    foregroundBusy: () => false, isOpen: () => true, debug: { record() {} }, failure: async () => {},
    feedback: async report => feedback.push(report),
    publisher: () => ({ replies: (...args) => progressSender = progressPush.replies(...args), deliver: async () => { progressDeliveries++; return false; } }),
    run: async (_scope, _text, _checkpoint, options) => {
      progressRuns++;
      options.onUpdate({ kind: 'tool', name: 'get_subtitles', arguments: 'PARAMETER_SENTINEL' });
      options.onUpdate({ kind: 'tool', name: 'get_subtitles' });
      options.onUpdate({ kind: 'tool-result', name: 'get_subtitles', status: 'completed', elapsedMs: 1250, result: 'BODY_SENTINEL' });
      options.onUpdate({ kind: 'explanation', text: 'COMMENTARY_SENTINEL' });
      options.onUpdate({ kind: 'answer' });
      if (!silent && options.onReply) await options.onReply('substantive answer', () => true);
      return { replyAttempted: !silent && options.onReply ? 1 : 0, groupRevision: 0,
        groupEpoch: (await context.batchStatus(scope)).epoch, startedAt: new Date().toISOString() };
    } });
  const progressTrigger = { kind: 'batch', reason: 'mention', status: await context.batchStatus(scope) };
  const saveProgressGroup = value => store.write(progressGroups.path(id), { ...group, ...value });
  await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  assert.equal(feedback.length, 6); assert.equal(progressSender.sent, 1);
  assert.deepEqual(progressMessages, ['substantive answer']);
  const beforeMonitor = feedback.length;
  await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  const monitored = feedback.slice(beforeMonitor);
  assert.equal(monitored.length, 6);
  assert.equal(monitored.filter(report => report.text === '开始读取字幕。').length, 2);
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
  silent = false; progressTasks.feedback = async () => { throw new Error('NOTICE_SEND_FAILED'); };
  await saveProgressGroup({ toolMonitor: true }); await progressTasks.process(group, progressTrigger);
  assert.equal(progressSender.failed, false); assert.equal(progressSender.sent, 1);
  assert.equal(progressMessages.at(-1), 'substantive answer');
  await saveProgressGroup({});

  const sent = []; const debug = { record() {} };
  const noticeController = { admins: ['admin'], debug, groupAccess: { read: async () => group } };
  const delivery = new QQDelivery({ markdown: false, diagnostics: new QQDiagnostics('fixture-secret', () => {}), onState() {},
    assertCanContinue: async () => {}, bot: { sendText: async (target, text) => {
      if (text === 'limited') throw Object.assign(new Error('QQ_REPLY_REJECTED'), { bizCode: 22009, httpStatus: 400 });
      sent.push({ target, text }); return {};
    } }, notifyAdmins: report => notices.send(report) });
  const serial = new SerialQueue(); delivery.proactive.run = (_target, operation) => serial.run(operation);
  const notices = new AdminNotifications(noticeController, delivery);
  const notice = { scope, reason: 'QQ_GROUP_REPLY_LIMIT', limitKind: 'passive', text: 'fixture signal' };
  await notices.send(notice); assert.equal(sent.length, 0);
  group.notifyReplyLimit = true;
  const response = new QQResponse({ message: { kind: 'group', groupOpenid: 'fixture', requestId: 'request',
    replyTarget: { scope: 'group', targetId: 'fixture', msgId: 'incoming' } }, delivery, debug, onState() {} });
  for (let i = 0; i < 6; i++) await response.send({ event: 'reply-part', text: `part ${i}` });
  assert.equal(sent.filter(row => row.target.scope === 'group').length, 6);
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 1);
  assert.equal(sent.filter(row => row.target.scope === 'group').at(-1).target.msgId, undefined);
  await notices.send(notice);
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 1);
  // A platform rejection on the shared proactive queue must release it before notifying administrators.
  let timer;
  try {
    await Promise.race([
      assert.rejects(delivery.send(scope, 'limited'), /QQ_RATE_LIMITED/),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('notification deadlock')), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 2);
  await assert.rejects(delivery.send(scope, 'limited', { isActive: () => true, beforeSend: async () => {} }), /QQ_RATE_LIMITED/);
  await delivery.replyLimit({ scope: 'c2c', targetId: 'admin' }, { kind: 'platform' });
  assert.equal(sent.filter(row => row.target.scope === 'c2c').length, 3);

  const privateResponse = new QQResponse({ message: { kind: 'c2c', senderId: 'user', requestId: 'private-request',
    replyTarget: { scope: 'c2c', targetId: 'user', msgId: 'private-incoming' } }, delivery, debug, onState() {} });
  for (let i = 0; i < 5; i++) await privateResponse.send({ event: 'reply-part', text: `private ${i}` });
  assert.equal(sent.filter(row => row.target.targetId === 'user' && row.target.msgId).length, 4);
  assert.equal(sent.filter(row => row.target.targetId === 'admin').length, 3);

  // Expired group threads are detached, while live threads and private threads are reused.
  let resets = 0; let calls = 0;
  const adapter = { reset: async () => { resets++; }, run: async options => {
    calls++; assert.equal(options.groupContext, null); await options.onCheckpoint({ threadId: `thread-${calls}` });
    await options.onInputAccepted();
    return { sharedState: null };
  }, compact: async () => true };
  controller = new VideoController({ adapter, store, admins: ['admin'] });
  // Even a direct handler caller cannot restore the old group foreground path.
  const groupMessage = { kind: 'group', groupOpenid: 'fixture', senderId: 'member', messageId: 'direct-group', content: 'hello' };
  let commandReplies = 0;
  await controller.messages.handle(groupMessage, async () => { commandReplies++; });
  assert.equal(calls, 0); assert.equal(commandReplies, 0);
  await controller.messages.handle({ ...groupMessage, messageId: 'direct-command', content: '/help' }, async () => { commandReplies++; });
  assert.equal(calls, 0); assert.equal(commandReplies, 1);
  await assert.rejects(controller.foreground.enqueue({ who: { scope, private: false } }), /FOREGROUND_PRIVATE_REQUIRED/);
  const checkpoint = { threadId: 'old-thread', model: 'fixture-model', seen: ['seen'], reasoningEffort: 'low' };
  await controller.run(scope, 'fixture request', checkpoint);
  assert.equal(resets, 1);
  assert.equal(checkpoint.model, 'fixture-model'); assert.deepEqual(checkpoint.seen, ['seen']);
  await controller.run(scope, 'fixture request', checkpoint);
  assert.equal(resets, 1);
  checkpoint.groupContextExpiresAt = Date.now() - 1;
  await controller.run(scope, 'fixture request', checkpoint);
  assert.equal(resets, 2);
  const privateCheckpoint = { threadId: 'private-thread' };
  await controller.run('c2c:admin', 'fixture request', privateCheckpoint);
  assert.equal(resets, 2);
  assert.equal(calls, 4);
  // Unsupported detail blobs cannot break retained-original recall or batches.
  const formatScope = 'group:format-fixture';
  await context.append({ groupOpenid: 'format-fixture', senderId: 'fixture', messageId: 'retained-original',
    content: 'retained original text', timestamp: new Date().toISOString() });
  const formatDb = await context.database(formatScope);
  formatDb.prepare('INSERT INTO message_details(message_id,body) VALUES(?,?)')
    .run('retained-original', JSON.stringify({ text: 'unsupported detail', attachments: [] }));
  const recalledOriginals = await context.recall(formatScope, {});
  assert.equal(recalledOriginals.messages[0].text, 'retained original text');
  assert.equal(recalledOriginals.messages[0].message, null);
  assert(!JSON.stringify(recalledOriginals).includes('unsupported detail'));
  assert.equal((await context.snapshot(formatScope, { batch: true })).messages.length, 1);

  console.log('Offline group checks passed: trigger alternatives, time filtering/cursors, settings, notification delivery and thread expiry.');
} finally {
  await closeTools?.();
  await controller?.groupContext.close();
  await context.close();
  await rm(root, { recursive: true, force: true });
}
