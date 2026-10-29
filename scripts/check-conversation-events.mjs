// Offline only: isolated temporary records, fake model RPC and fake QQ replies.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationEvents } from '../lib/conversation-events.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { CodexAdapter } from '../lib/codex-adapter.mjs';
import { Store } from '../lib/store.mjs';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';
import { registerEventTools } from '../lib/tools/events.mjs';
import { toolPolicy, toolApprovals } from '../lib/tool-policy.mjs';
import { DatabaseSync } from 'node:sqlite';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('FIXTURE_TIMEOUT'); await delay(5); }
}
const root = await mkdtemp(join(tmpdir(), 'watch-event-check-'));
let bridge; let controller;
const inboxes = [];
try {
  let interrupts = 0, wakes = 0, commits = 0;
  const inbox = new ConversationEvents({ graceMs: 20 }); inboxes.push(inbox);
  const options = { interrupt: () => interrupts++, wake: () => wakes++, canReadMessages: true };
  let turn = inbox.begin(options);
  inbox.guard(turn, true);
  const entry = inbox.add('one', 'message', async () => ({ text: 'fixture' }), async () => { commits++; });
  await delay(30); assert.equal(interrupts, 0); assert.equal(wakes, 1);
  inbox.guard(turn, false); await delay(2); assert.equal(wakes, 1);
  const read = await inbox.read(turn);
  assert.equal(read.events[0].data.text, 'fixture'); assert.equal(commits, 1);
  await delay(25); assert.equal(interrupts, 0);
  await inbox.finish(turn); assert.equal(entry.supplied, true);
  turn = inbox.begin(options); await inbox.read(turn); await inbox.finish(turn);
  assert.equal(commits, 1); assert.equal(entry.supplied, true);
  assert.throws(() => inbox.guard(turn, true), /EVENT_TURN_EXPIRED/);

  turn = inbox.begin(options); inbox.guard(turn, true);
  inbox.add('two', 'message', async () => ({}));
  await delay(30); assert.equal(inbox.status().guarded, true);
  await inbox.notify(turn, { kind: 'media_ready', media_id: 'a'.repeat(32), request_id: 'b'.repeat(32), frameCount: 4 });
  assert.equal(interrupts, 0);
  assert((await inbox.read(turn)).notices.some(notice => notice.kind === 'media_ready'));
  await inbox.finish(turn); assert.equal(turn.guarded, false);
  inbox.close();

  // Failed loads retain unsupplied messages; concurrent reads serialize.
  turn = inbox.begin(options); const loading = deferred();
  inbox.add('loading', 'message', () => loading.promise);
  const firstRead = inbox.read(turn); const secondRead = inbox.read(turn);
  loading.resolve({}); assert.equal((await firstRead).events.length, 1); assert.equal((await secondRead).events.length, 0);
  inbox.close();
  turn = inbox.begin(options);
  inbox.add('failure', 'message', async () => { throw new Error('FIXTURE_LOAD_FAILED'); });
  await assert.rejects(inbox.read(turn), /FIXTURE_LOAD_FAILED/); assert.equal(inbox.status().pendingCount, 1);
  inbox.close();

  // Waiting is event-driven, does not consume bodies, and ignores media notices.
  turn = inbox.begin(options);
  const waiting = inbox.wait(turn, 1000);
  assert.throws(() => inbox.wait(turn, 1000), /EVENT_WAIT_ALREADY_PENDING/);
  await inbox.notify(turn, { kind: 'media_ready' });
  assert(turn.waiter);
  inbox.add('wait-message', 'message', async () => ({ text: 'arrived' }));
  assert.equal(await waiting, true);
  assert.equal(inbox.status().pendingCount, 1);
  assert.equal(await inbox.wait(turn, 1000), true);
  assert.equal((await inbox.read(turn)).events[0].data.text, 'arrived');
  assert.equal(await inbox.wait(turn, 5), false); assert.equal(turn.waiter, null);
  const waitAbort = new AbortController();
  const cancelledWait = inbox.wait(turn, 1000, waitAbort.signal);
  const cancelledCheck = assert.rejects(cancelledWait, /EVENT_TURN_EXPIRED/);
  waitAbort.abort(); await cancelledCheck; assert.equal(turn.waiter, null);
  const closingWait = inbox.wait(turn, 1000);
  const closingCheck = assert.rejects(closingWait, /EVENT_TURN_EXPIRED/);
  await inbox.finish(turn); await closingCheck;
  turn = inbox.begin({ ...options, canReadMessages: false });
  assert.throws(() => inbox.wait(turn, 1000), /EVENT_MESSAGES_NOT_ALLOWED/);
  inbox.close();

  // Token-bound event IPC shares the existing bridge; it never grants send access.
  bridge = await ReplyBridge.open(); turn = inbox.begin(options);
  const binding = bridge.bind({ id: '11111111-1111-4111-8111-111111111111',
    events: async (seconds = 0, signal) => {
      const ready = seconds ? await inbox.wait(turn, seconds * 1000, signal) : true;
      return { ...await inbox.read(turn), timedOut: !ready };
    }, guard: enabled => inbox.guard(turn, enabled) });
  const registered = new Map(); registerEventTools((name, description, schema, action) => registered.set(name, action), bridge.path);
  for (const name of registered.keys()) {
    assert(Object.hasOwn(toolPolicy(), name)); assert(toolApprovals().enabled_tools.includes(name));
  }
  const token = binding.turn.id;
  assert.equal((await callReplyBridge(bridge.path, { action: 'set_interrupt_guard', turn_id: token, enabled: true })).guarded, true);
  assert.equal((await callReplyBridge(bridge.path, { action: 'set_interrupt_guard', turn_id: token, enabled: 'invalid' })).code, 'INTERRUPT_GUARD_INVALID');
  assert.equal((await callReplyBridge(bridge.path, { turn_id: token, part_id: 1, kind: 'message', text: 'blocked' })).code, 'TURN_ACTION_NOT_ALLOWED');
  inbox.add('large', 'message', async () => ({ text: 'x'.repeat(24000) }));
  const blocks = await registered.get('check_pending_events')({ turn_id: token });
  assert.equal(blocks[0].single().events[0].data.text.length, 24000);
  assert.equal((await callReplyBridge(bridge.path, { action: 'wait_reply', turn_id: token, timeout_seconds: 51 })).code, 'EVENT_WAIT_TIMEOUT_INVALID');
  const ipcWait = registered.get('wait_reply')({ turn_id: token, timeout_seconds: 1 });
  await until(() => turn.waiter);
  inbox.add('ipc-wait', 'message', async () => ({ text: 'via IPC' }));
  const waitBlocks = await ipcWait;
  assert.equal(waitBlocks[0].single().events[0].data.text, 'via IPC');
  assert.equal(waitBlocks[0].single().timedOut, false);
  const timedOut = await registered.get('wait_reply')({ turn_id: token, timeout_seconds: 1 });
  assert.equal(timedOut[0].single().timedOut, true);
  assert.deepEqual(timedOut[0].single().events, []);
  await until(() => !turn.waiter);
  await assert.rejects(callReplyBridge(bridge.path, { action: 'wait_reply', turn_id: token, timeout_seconds: 1 }, { timeoutMs: 15 }), /REPLY_DELIVERY_UNKNOWN/);
  await until(() => !turn.waiter);
  inbox.add('after-disconnect', 'message', async () => ({ text: 'retained' }));
  assert.equal((await inbox.read(turn)).events[0].data.text, 'retained');
  binding.close();
  assert.equal((await callReplyBridge(bridge.path, { action: 'check_pending_events', turn_id: token })).code, 'REPLY_TURN_EXPIRED');
  inbox.close();

  // Native steering is bound to the captured active turn, never its successor.
  const rpc = new EventEmitter(); const calls = [];
  rpc.request = async (method, params) => { calls.push({ method, params }); return {}; };
  const adapter = new CodexAdapter();
  const nativeTurn = { id: 'native-turn', ready: Promise.resolve(), settled: false };
  adapter.sessions.set('c2c:fixture', { rpc, threadId: 'thread', turn: nativeTurn });
  assert.equal(await adapter.steer('c2c:fixture', { pendingCount: 1 }), true);
  assert.equal(calls[0].method, 'turn/steer'); assert.equal(calls[0].params.expectedTurnId, 'native-turn');
  nativeTurn.settled = true; assert.equal(await adapter.steer('c2c:fixture', {}), false);

  // Exercise the real adapter turn lifecycle with an in-memory RPC transport.
  const turnRpc = new EventEmitter(); const turnCalls = [];
  turnRpc.request = async (method, params) => {
    turnCalls.push({ method, params }); return method === 'turn/start' ? { turn: { id: 'rpc-turn' } } : {};
  };
  turnRpc.close = () => { turnRpc.emit('closed'); };
  const session = { rpc: turnRpc, bridge, threadId: 'rpc-thread', model: 'fixture', turns: 0 };
  adapter.prepare = async () => session; adapter.modelsFor = async () => [{ id: 'fixture', defaultEffort: 'low' }];
  adapter.sessions.set('c2c:rpc', session);
  const abort = new AbortController(); const toolUpdates = []; const toolDiagnostics = [];
  let ended = false;
  const adapterTurn = adapter.runTurn({ scope: 'c2c:rpc', text: 'offline', signal: abort.signal,
    onUpdate: event => toolUpdates.push(event), onDiagnostic: (stage, details) => toolDiagnostics.push({ stage, ...details }),
    onTurnEnd: () => { ended = true; },
    onEvents: async () => ({ ok: true, events: [{ kind: 'fixture' }] }), onGuard: async () => ({ ok: true }) });
  await until(() => session.turn?.id);
  assert.equal((await callReplyBridge(bridge.path, { action: 'check_pending_events', turn_id: bridge.active.id })).events[0].kind, 'fixture');
  assert(turnCalls[0].params.input[0].text.includes('Current-turn event channel:'));
  assert.deepEqual(turnCalls[0].params.outputSchema.required, ['pauseBrowsing', 'sharedState']);
  assert.deepEqual(Object.keys(turnCalls[0].params.outputSchema.properties), ['pauseBrowsing', 'sharedState']);
  const toolEvent = (method, item, threadId = 'rpc-thread') => turnRpc.emit('notification', { method, params: { threadId, item } });
  const firstTool = { type: 'mcpToolCall', server: 'video', tool: 'read_webpage_media', id: 'frame-one', arguments: { text: 'PARAMETER_SENTINEL' } };
  const secondTool = { ...firstTool, id: 'frame-two' };
  toolEvent('item/started', firstTool, 'unrelated-thread'); assert.equal(toolUpdates.length, 0);
  toolEvent('item/started', firstTool); toolEvent('item/started', secondTool);
  toolEvent('item/completed', { ...firstTool, result: { content: [{ type: 'text', text: 'BODY_SENTINEL' }] } });
  toolEvent('item/completed', { ...secondTool, result: { isError: true, content: [{ type: 'text', text: '{"ok":false,"code":"FRAME_TIMEOUT"}' }] } });
  const searchTool = { type: 'webSearch', id: 'search-one', action: { type: 'search', query: 'QUERY_SENTINEL' } };
  toolEvent('item/started', searchTool); toolEvent('item/completed', { ...searchTool, status: 'completed' });
  toolEvent('item/started', { ...firstTool, id: 'pending-frame' });
  assert.deepEqual(toolUpdates.filter(event => event.kind === 'tool-result').map(event => event.status), ['completed', 'failed', 'completed']);
  assert(toolUpdates.filter(event => event.kind === 'tool-result').every(event => event.elapsedMs >= 0));
  assert(toolDiagnostics.some(event => event.stage === 'mcp_failed' && event.reason === 'FRAME_TIMEOUT' && event.elapsedMs >= 0));
  toolEvent('item/completed', { type: 'agentMessage', phase: 'commentary', text: 'COMMENTARY_SENTINEL' });
  assert(!toolUpdates.some(event => event.kind === 'explanation'));
  assert(!JSON.stringify(toolUpdates).includes('SENTINEL'));
  abort.abort(); await assert.rejects(adapterTurn, /TURN_CANCELLED/);
  assert.equal(toolUpdates.at(-1).status, 'interrupted');
  assert.equal(bridge.active, null); assert.equal(session.turn, null); assert.equal(ended, true);
  assert(turnCalls.some(call => call.method === 'turn/interrupt'));

  // A fast model completion cannot race ahead of persisting its input receipt;
  // a rejected submission must never create such a receipt.
  const receiptGate = deferred(); let receiptCommitted = false; let settled = false;
  const completedEarly = adapter.runTurn({ scope: 'c2c:rpc', text: 'new body',
    onInputAccepted: async () => { await receiptGate.promise; receiptCommitted = true; } });
  completedEarly.finally(() => { settled = true; });
  await until(() => session.turn?.id);
  turnRpc.emit('notification', { method: 'item/completed', params: { threadId: 'rpc-thread',
    item: { type: 'agentMessage', text: JSON.stringify({ pauseBrowsing: false, sharedState: null }) } } });
  turnRpc.emit('notification', { method: 'turn/completed', params: { threadId: 'rpc-thread', turn: { status: 'completed' } } });
  await delay(5); assert.equal(settled, false); receiptGate.resolve(); await completedEarly;
  assert.equal(receiptCommitted, true);
  turnRpc.request = async () => { throw new Error('FIXTURE_SUBMISSION_REJECTED'); };
  let rejectedReceipt = false;
  await assert.rejects(adapter.runTurn({ scope: 'c2c:rpc', text: 'rejected body',
    onInputAccepted: async () => { rejectedReceipt = true; } }), /FIXTURE_SUBMISSION_REJECTED/);
  assert.equal(rejectedReceipt, false);

  const store = new Store(root); const runs = []; const controls = [];
  const fake = {
    reset: async () => {}, compact: async () => false, close: async () => {}, steer: async () => true,
    run: async options => {
      runs.push(options); await options.onInputAccepted(); const done = deferred(); controls.push(done);
      const abort = () => done.resolve('aborted'); options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
      const state = await done.promise; options.signal.removeEventListener('abort', abort);
      if (state === 'aborted') throw new Error('TURN_CANCELLED');
      return { pauseBrowsing: false, sharedState: null, replyAnswerSent: 0, replyDeliveryFailed: false };
    },
  };
  controller = new VideoController({ adapter: fake, store, admins: ['fixture'], compactEvery: 100 });
  const scope = 'c2c:fixture'; const lane = controller.lane(scope); lane.events.graceMs = 40;
  const replies = [];
  const enqueue = id => controller.foreground.enqueue({ who: { scope, admin: true, private: true },
    message: { messageId: id, senderId: 'fixture', senderName: 'fixture', kind: 'c2c', content: id, requestId: id, images: [] },
    text: id, reply: async value => { if (!value.isActive || value.isActive()) replies.push(value); }, ignored: () => {} });
  const first = enqueue('first'); await until(() => controls.length === 1);
  await runs[0].onGuard(true, 30);
  const privateWait = runs[0].onEvents(1);
  await until(() => lane.events.active.waiter);
  const second = enqueue('second');
  const events = await privateWait; assert.equal(events.events[0].data.text, undefined);
  assert.equal(events.events[0].data.messageContent.components.find(item => item.type === 'text').text, 'second');
  assert.equal(events.timedOut, false);
  await delay(50); assert.equal(runs[0].signal.aborted, false);
  assert((await store.conversation(scope)).seen.includes('second'));
  await runs[0].onReply('answered both', 'current');
  controls[0].resolve(); await Promise.all([first, second]);
  assert.equal(runs.length, 1); assert((await store.conversation(scope)).seen.includes('second'));

  // No safe-point read: cancel only this conversation, preserve accepted output,
  // and hand unfinished work to the queued request. Old callbacks cannot send.
  const third = enqueue('third'); await until(() => controls.length === 2);
  await runs[1].onReply('accepted before interruption', 'current');
  const fourth = enqueue('fourth'); await until(() => controls.length === 3);
  assert.equal(runs[1].signal.aborted, true);
  assert.equal(runs[2].interruptedWork[0].requestId, 'third');
  assert.equal(runs[2].interruptedWork[0].text, undefined);
  assert.equal(runs[2].groupContext, null);
  assert.equal(runs[2].interruptedWork[0].acceptedReplies[0].text, 'accepted before interruption');
  await assert.rejects(runs[1].onReply('stale', 'current'), /REPLY_TURN_EXPIRED/);
  controls[2].resolve(); await Promise.all([third, fourth]);
  assert.deepEqual(lane.interruptedWork, []);

  // Unrelated chats do not cancel each other, and administrator stop wins guards.
  const fifth = enqueue('fifth'); await until(() => controls.length === 4); await runs[3].onGuard(true, 30);
  const stopWait = runs[3].onEvents(1);
  const stopCheck = assert.rejects(stopWait, /EVENT_TURN_EXPIRED/);
  await until(() => lane.events.active.waiter);
  const other = 'c2c:other';
  const otherRun = controller.run(other, 'other', await store.conversation(other));
  await until(() => controls.length === 5); assert.equal(runs[3].signal.aborted, false);
  await controller.stopConversation(scope); await fifth;
  await stopCheck;
  assert.equal(runs[3].signal.aborted, true); assert.equal(runs[4].signal.aborted, false);
  assert.deepEqual(lane.interruptedWork, []); controls[4].resolve(); await otherRun;

  // Group event readiness counts only new messages, with the configured OR
  // conditions and recent-context bounds. Receipt is independent of completion.
  const gs = 'group:fixture'; const gid = scopeId(gs); const gl = controller.lane(gs);
  const group = { id: gid, openid: 'fixture', allowed: true, listen: true, engage: true,
    schedule: { maxMessages: 5, maxChars: 200, maxWaitSeconds: 30 } };
  await store.write(controller.groupAccess.path(gid), group);
  const append = async (id, text = id, botMentioned = false) => {
    const message = { kind: 'group', groupOpenid: 'fixture', senderId: 'member',
      messageId: id, senderName: 'fixture', content: text, botMentioned, timestamp: new Date().toISOString() };
    message.structure = await controller.messageRecords.capture(gs, message, null, true);
    return controller.groupContext.append(message);
  };
  for (let i = 0; i < 5; i++) await append(`initial-${i}`);
  const initial = await controller.groupContext.snapshot(gs, { batch: true });
  await controller.recordModelInput(gs, initial.messages.map(row => row.messageId), initial.epoch);
  gl.active = { controller: new AbortController() };
  const gt = gl.events.begin(options); gt.inputAccepted = true;
  await controller.groupRuntime.notifyEvents(gs); assert.equal(gl.events.status().pendingCount, 0);
  await append('fresh-one'); await controller.groupRuntime.notifyEvents(gs);
  assert.equal(gl.events.status().pendingCount, 0); assert(gl.messageTimer);
  for (let i = 2; i <= 5; i++) await append(`fresh-${i}`);
  await controller.groupRuntime.notifyEvents(gs); assert.equal(gl.events.status().pendingCount, 1);
  const batch = await gl.events.read(gt);
  assert.equal(batch.events[0].data.messages.length, 5);
  assert(batch.events[0].data.messages.every(row => !('text' in row) && row.message.components.some(c => c.type === 'text' && c.text.startsWith('fresh'))));
  assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  await gl.events.finish(gt); assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  const gt2 = gl.events.begin(options); gt2.inputAccepted = true;
  await append('before-mention');
  await append('immediate-mention', 'question', true);
  await controller.groupRuntime.notifyEvents(gs);
  assert.equal(gl.events.status().pendingCount, 1);
  const mentionBatch = await gl.events.read(gt2);
  assert.deepEqual(mentionBatch.events[0].data.messages.map(row => row.messageId), ['before-mention', 'immediate-mention']);
  assert.equal(mentionBatch.events[0].data.messages[1].message.botMentioned, true);
  assert.equal((await controller.groupContext.batchStatus(gs)).pendingMentions, 0);
  await controller.groupRuntime.notifyEvents(gs); assert.equal(gl.events.status().pendingCount, 0);
  await gl.events.finish(gt2);
  assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  gl.active = null;

  // Collection-only groups never feed ordinary messages into a reply-capable turn.
  await store.write(controller.groupAccess.path(gid), { ...group, engage: false });
  gl.active = { controller: new AbortController() };
  gl.events.begin(options); await append('chars', 'a'.repeat(210));
  await controller.groupRuntime.notifyEvents(gs); assert.equal(gl.events.status().pendingCount, 0);
  gl.events.close(); gl.active = null; clearTimeout(gl.messageTimer);

  // Input receipts are committed before explicit replies; completion adds no fallback.
  await store.write(controller.groupAccess.path(gid), group);
  let deliveredPhase = false;
  const groupSender = { sent: 0, close() {}, sendPart: async () => {
    deliveredPhase = true; groupSender.sent++;
    assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  } };
  controller.groupPublisher = { replies: () => groupSender,
    deliver: async () => { throw new Error('UNEXPECTED_CHAT_COMPENSATION'); } };
  const runIndex = runs.length;
  const groupTask = controller.groupTasks.process(group, { kind: 'batch', reason: 'chars', status: await controller.groupContext.batchStatus(gs) });
  await until(() => controls.length > runIndex);
  const groupRun = runs[runIndex];
  for (let i = 0; i < 5; i++) await append(`inline-${i}`);
  await controller.groupRuntime.notifyEvents(gs);
  assert.equal((await groupRun.onEvents()).events[0].data.messages.length, 5);
  assert((await controller.groupContext.batchStatus(gs)).pendingCount === 0);
  // Explicit waiting accepts one ordinary message below all batch thresholds.
  const groupWait = groupRun.onEvents(1);
  await until(() => gl.events.active.waiter);
  await append('single-while-waiting'); await controller.groupRuntime.notifyEvents(gs);
  const single = await groupWait;
  assert.equal(single.timedOut, false);
  assert.deepEqual(single.events[0].data.messages.map(row => row.messageId), ['single-while-waiting']);
  assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  // Already collected input is also immediately available when waiting begins.
  await append('already-pending'); await controller.groupRuntime.notifyEvents(gs);
  assert.equal(gl.events.status().pendingCount, 0);
  assert.equal((await groupRun.onEvents(1)).events[0].data.messages[0].messageId, 'already-pending');
  await groupRun.onReply('explicit group answer', 'current');
  // Collection-only settings revoke waiting even for a turn admitted earlier.
  const revokedWait = groupRun.onEvents(1);
  const revokedCheck = assert.rejects(revokedWait, /EVENT_TURN_EXPIRED/);
  await until(() => gl.events.active.waiter);
  await store.write(controller.groupAccess.path(gid), { ...group, engage: false });
  controller.groupRuntime.bind({ ...group, engage: false });
  await revokedCheck;
  await assert.rejects(groupRun.onEvents(1), /EVENT_MESSAGES_NOT_ALLOWED/);
  await store.write(controller.groupAccess.path(gid), group);
  controller.groupRuntime.bind(group);
  controls[runIndex].resolve(); await groupTask;
  assert.equal(deliveredPhase, true); assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);

  // Out-of-order mentions cannot consume earlier ordinary input. Once supplied,
  // neither a fresh snapshot, cancellation nor opening a new DB handle replays it.
  for (let i = 0; i < 45; i++) await append(`unseen-${i}`);
  await append('mentioned-last');
  await controller.recordModelInput(gs, ['mentioned-last']);
  assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 45);
  const firstNew = await controller.groupContext.snapshot(gs, { batch: true });
  assert(firstNew.messages.length > 0 && firstNew.messages.length <= 40);
  assert(!firstNew.messages.some(row => row.messageId === 'mentioned-last'));
  await controller.recordModelInput(gs, firstNew.messages.map(row => row.messageId), firstNew.epoch);
  const remainingIds = [];
  while ((await controller.groupContext.batchStatus(gs)).pendingCount) {
    const nextNew = await controller.groupContext.snapshot(gs, { batch: true });
    assert(nextNew.messages.length > 0);
    remainingIds.push(...nextNew.messages.map(row => row.messageId));
    await controller.recordModelInput(gs, nextNew.messages.map(row => row.messageId), nextNew.epoch);
  }
  assert.deepEqual(remainingIds, Array.from({ length: 45 - firstNew.messages.length }, (_, index) => `unseen-${firstNew.messages.length + index}`));
  assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  assert.deepEqual((await controller.groupContext.snapshot(gs)).messages, []);
  await controller.groupContext.close();
  assert.deepEqual((await controller.groupContext.snapshot(gs, { batch: true })).messages, []);
  const recalled = await controller.groupContext.recall(gs, { limit: 40 });
  assert(recalled.messages.length > 0); assert.equal((await controller.groupContext.batchStatus(gs)).pendingCount, 0);
  // A new model thread receives no historical group snapshot.
  const freshIndex = controls.length;
  const freshThread = controller.run(gs, 'fresh request', { seen: [], threadId: null }, { inputMessageIds: ['fresh-request'] });
  await until(() => controls.length > freshIndex);
  assert.equal(runs[freshIndex].groupContext, null); controls[freshIndex].resolve(); await freshThread;

  for (let i = 0; i < 45; i++) await append(`event-new-${i}`);
  gl.active = { controller: new AbortController() };
  const chunksTurn = gl.events.begin(options); chunksTurn.inputAccepted = true;
  const chunkIds = []; const chunkEvents = [];
  while ((await controller.groupContext.batchStatus(gs)).pendingCount) {
    await controller.groupRuntime.notifyEvents(gs);
    const chunk = (await gl.events.read(chunksTurn)).events[0];
    assert(chunk.data.messages.length > 0);
    chunkEvents.push(chunk.id); chunkIds.push(...chunk.data.messages.map(row => row.messageId));
  }
  assert.equal(new Set(chunkEvents).size, chunkEvents.length);
  assert.equal(chunkIds.length, 45); assert.equal(new Set(chunkIds).size, 45);
  await gl.events.finish(chunksTurn); gl.active = null; clearTimeout(gl.messageTimer);

  // A valid pre-receipt schema: completed batches and foreground seen IDs seed
  // the new ledger without swallowing an older, undelivered ordinary message.
  const legacyScope = 'group:legacy';
  const legacy = new DatabaseSync(join(root, 'group-context', `${scopeId(legacyScope)}.sqlite`));
  legacy.exec(`CREATE TABLE messages(revision INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,openid TEXT NOT NULL,name TEXT NOT NULL,timestamp INTEGER NOT NULL,received INTEGER NOT NULL,text TEXT NOT NULL);
    CREATE TABLE activity(id INTEGER PRIMARY KEY,processed INTEGER NOT NULL DEFAULT 0,idle_reserved INTEGER NOT NULL DEFAULT 0,last_batch INTEGER NOT NULL DEFAULT 0,last_human INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO activity(id,processed) VALUES(1,1);`);
  for (const id of ['old-completed', 'older-unseen', 'old-mentioned']) legacy.prepare('INSERT INTO messages(id,openid,name,timestamp,received,text) VALUES(?,?,?,?,?,?)').run(id, 'member', 'fixture', Date.now(), Date.now(), id);
  legacy.close(); await store.saveConversation(legacyScope, { seen: ['old-mentioned'] });
  const migrated = await controller.groupContext.snapshot(legacyScope, { batch: true });
  assert.deepEqual(migrated.messages.map(row => row.messageId), ['older-unseen']);
  assert(!replies.some(value => value.text === 'stale'));
  console.log('Offline conversation-event checks passed: incremental intake/guards, cancellable waits/timeouts, token IPC/disconnect, native steering, foreground handoff/isolation, stop/revocation, group batching and cursors.');
} finally {
  for (const inbox of inboxes) inbox.close();
  await bridge?.close(); await controller?.close();
  await rm(root, { recursive: true, force: true });
}
