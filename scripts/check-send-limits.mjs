import { z } from 'zod';
// Offline only: disposable state, real reply IPC and fake QQ responses; no network/model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { scopeId } from '../lib/policy.mjs';
import { VideoController } from '../lib/controller.mjs';
import { ChatDelivery } from '../lib/chat-delivery.mjs';
import { DeliveryDiagnostics } from '../lib/delivery-errors.mjs';
import { ChatResponse } from '../lib/chat-response.mjs';
import { ConversationRequests } from '../lib/conversation-requests.mjs';
import { GroupPush } from '../lib/group-push.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { SerialQueue } from '../lib/serial-queue.mjs';
import { registerReplyTools } from '../lib/tools/replies.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-send-limits-'));
const store = new Store(root);
let controller; let bridge;
try {
  const queue = new SerialQueue(); const ordered = [];
  let timer;
  try {
    await Promise.race([
      Promise.all([1, 2, 3].map(i => queue.run(async () => { ordered.push(i); }))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LOCAL_SEND_DELAY')), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(ordered, [1, 2, 3]);
  await assert.rejects(queue.run(async () => { throw new Error('fixture'); }), /fixture/);
  await queue.run(async () => ordered.push(4)); assert.equal(ordered.at(-1), 4);

  controller = new VideoController({ store, admins: ['operator'], adapter: { close: async () => {}, reset: async () => {} } });
  const scope = 'group:fixture'; const id = scopeId(scope);
  await store.write(controller.groupAccess.path(id), { id, openid: 'fixture', name: 'Fixture', allowed: true,
    listen: true, engage: true, push: true, toolMonitor: true, observedAt: new Date().toISOString() });
  const calls = []; const events = []; let rejectNext = null; let rejectAll = false;
  const limited = (httpStatus = 429, bizCode) => Object.assign(new Error('QQ_RATE_LIMITED'), {
    httpStatus, bizCode, traceId: 'fixture-trace', bizMessage: 'fixture-secret rate limit', body: 'UNTRUSTED_BODY',
  });
  assert.throws(() => new ChatDelivery({}), /CHAT_TRANSPORT_REQUIRED/);
  const delivery = new ChatDelivery({ diagnostics: new DeliveryDiagnostics(),
    onState: (state, details) => events.push({ state, ...details }), assertCanContinue: async () => {},
    notifyAdmins: report => notices.send(report), transport: async (target, { text }, { beforeCommit }) => {
      await beforeCommit();
      calls.push({ target, text });
      if (rejectAll) throw limited();
      if (rejectNext && target.targetId !== 'operator') { const error = rejectNext; rejectNext = null; throw error; }
      return { id: 'accepted' };
    } });
  const notices = new AdminNotifications(controller, delivery);
  controller.sendRoutedReply = (scope, text, isActive, beforeSend, media, beforeCommit) =>
    delivery.send(scope, { text, media }, { isActive, beforeSend, beforeCommit });
  const target = { scope: 'group', targetId: 'fixture' };
  for (const error of [limited(), limited(400, 777)]) {
    const before = calls.length; rejectNext = error;
    await assert.rejects(delivery.send(scope, 'limited'), result => result.message === 'QQ_RATE_LIMITED'
      && result.traceId === 'fixture-trace' && result.httpStatus === error.httpStatus);
    assert.equal(calls.length, before + 2); // One rejected call plus one administrator notice.
    assert.equal(calls.at(-1).target.targetId, 'operator');
    assert(calls.at(-1).text.includes('限流')); assert(!calls.at(-1).text.includes('fixture-secret'));
  }
  // Notification failures must not recurse or fall back to the source chat.
  rejectAll = true; const beforeNoticeFailure = calls.length;
  await assert.rejects(delivery.send(scope, 'limited'), /QQ_RATE_LIMITED/);
  assert.equal(calls.length, beforeNoticeFailure + 2); rejectAll = false;

  const routing = await controller.replyRouting.session('c2c:operator', 'routing', () => true);
  rejectNext = limited();
  await assert.rejects(routing.send(`group:${id}`, 'limited routed message'), /QQ_RATE_LIMITED/);
  let group = await controller.groupAccess.read(id);
  assert(!group.taskBlocked); assert.equal(group.pushPending, false); assert.equal(group.pushOwner, undefined);
  await routing.send(`group:${id}`, 'new routed message');

  const publisher = new GroupPush(controller.groupAccess, controller.groupContext,
    (openid, text, { media, ...options } = {}) => delivery.send(`group:${openid}`, { text, media }, options), error => delivery.diagnostics.format('failed', error),
    (state, details) => events.push({ state, ...details }), error => delivery.diagnostics.errorDetails(error));
  const sender = publisher.replies(id, 'chat', { requestId: 'group', scope, isActive: () => true, stopReason: () => 'STOPPED' });
  rejectNext = limited(); await assert.rejects(sender.sendPart('limited group reply', () => true), /QQ_RATE_LIMITED/);
  assert.equal(sender.failed, false); assert.equal((await controller.groupAccess.read(id)).pushPending, false);
  await sender.sendPart('new group reply', () => true); assert.equal(sender.sent, 1);
  assert(events.some(event => event.state === 'group_reply_rejected'));
  assert(!events.some(event => event.state === 'group_push_failed'));

  const response = new ChatResponse({ message: { kind: 'group', groupOpenid: 'fixture', requestId: 'current',
    replyTarget: { ...target, msgId: 'incoming' } }, delivery, debug: { record() {} }, onState() {} });
  bridge = await ReplyBridge.open(); const turnId = randomUUID();
  const binding = bridge.bind({ id: turnId, send: (text, _target, _media, isActive) => response.send({ event: 'reply-part', text, isActive }) });
  let action; let failure; let replySchema;
  registerReplyTools((name, _description, _schema, run, onFailure) => { assert.equal(name, 'send_reply'); replySchema = z.object(_schema); action = run; failure = onFailure; }, bridge.path);
  assert.equal(replySchema.shape.kind, undefined);
  const args = { turn_id: turnId, part_id: 1, target: 'current', text: 'not delivered' };
  rejectNext = limited();
  const raw = await callReplyBridge(bridge.path, args);
  assert.equal(raw.code, 'QQ_RATE_LIMITED'); assert.equal(raw.delivery, 'rejected');
  assert.equal(raw.platform.httpStatus, 429); assert.equal(raw.platform.traceId, 'fixture-trace');
  assert(!JSON.stringify(raw).includes('UNTRUSTED_BODY'));
  assert.equal(binding.turn.failed, false); assert.equal(binding.turn.currentRejected, true); assert.equal(response.failed, false);
  // Reusing the rejected part ID returns the same result without resubmission.
  const beforeRepeat = calls.length;
  await assert.rejects(action(args), error => {
    const result = failure(error).content[0].single();
    return result.code === 'QQ_RATE_LIMITED' && result.platform.httpStatus === 429 && result.recovery.includes('Do not') && result.rate_limited;
  });
  assert.equal(calls.length, beforeRepeat);
  const verbatim = '  标点，和换行。\n[资料](https://example.com) ' + '长回复'.repeat(800);
  const longArgs = replySchema.parse({ ...args, part_id: 2, text: verbatim });
  await action(longArgs); assert.equal(binding.turn.answerSent, 1);
  assert.equal(calls.at(-1).text, verbatim);
  // Uncertain delivery retains the normal terminal stop rule.
  rejectNext = Object.assign(new Error('timeout'), { httpStatus: 0 });
  await assert.rejects(action({ ...args, part_id: 3, text: 'uncertain' }), /QQ_REPLY_FAILED/);
  assert.equal(binding.turn.failed, true); assert.equal(response.failed, true);
  group = await controller.groupAccess.read(id); assert(!group.taskBlocked);
  // Current-chat rejection avoids compensation, while
  // leaving task completion and future group processing available.
  controller.adapter.run = async () => ({ replyCurrentRejected: true,
    replyAnswerSent: 0, replyDeliveryFailed: false, sharedState: null });
  const result = await controller.run('c2c:operator', 'fixture', {});
  assert.equal(result.replyCurrentRejected, true);
  let videoFallback = 0; let bodyFallback = 0;
  const lane = { tail: Promise.resolve(), epoch: 0, pending: 0, active: null, failures: 0, interruptedWork: [] };
  await controller.groupAccess.update(id, value => { value.toolMonitor = false; });
  const tasks = new ConversationRequests({ groupAccess: controller.groupAccess, groupContext: controller.groupContext, store,
    lane: () => lane, foregroundPending: () => false, closed: false, debug: { record() {} },
    reportTaskFailure: async () => { throw new Error('RATE_LIMIT_PAUSED_TASK'); },
    run: async () => ({ ...result, startedAt: new Date().toISOString(),
      groupRevision: 0, groupEpoch: (await controller.groupContext.batchStatus(scope)).epoch }),
    groupPublisher: { replies: () => ({ sent: 0, sendPart: async () => { bodyFallback++; }, close() {} }),
      deliver: async () => { videoFallback++; } },
  });
  await tasks.process(await controller.groupAccess.read(id), { kind: 'batch', reason: 'mention', status: { pendingCount: 1, pendingChars: 1 } });
  assert.equal(bodyFallback, 0); assert.equal(videoFallback, 0);
  assert.equal(lane.failures, 0); assert(!(await controller.groupAccess.read(id)).taskBlocked);
  // Successful silent chat completion never sends a message or saved video.
  controller.adapter.run = async () => ({ sharedState: null });
  let silentSends = 0;
  await controller.run('c2c:operator', 'silent fixture', {}, { onReply: async () => { silentSends++; } });
  assert.equal(silentSends, 0);
  result.replyCurrentRejected = false;
  await tasks.process(await controller.groupAccess.read(id), { kind: 'batch', reason: 'mention', status: { pendingCount: 1, pendingChars: 1 } });
  assert.equal(bodyFallback, 0); assert.equal(videoFallback, 0);
  await tasks.process(await controller.groupAccess.read(id), { kind: 'discover', reason: 'video', status: { pendingCount: 0, pendingChars: 0 } });
  assert.equal(bodyFallback, 0); assert.equal(videoFallback, 1); // Dedicated discovery publication remains.

  console.log('Offline send-limit checks passed: no local delay, typed platform rejection, private notices without recursion, group reservations, live IPC/model errors, idempotency and uncertain-delivery stop.');
} finally { await bridge?.close(); await controller?.close(); await rm(root, { recursive: true, force: true }); }
