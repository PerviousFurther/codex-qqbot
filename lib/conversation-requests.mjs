import { randomUUID } from 'node:crypto';
import { deliveryRateLimited } from './delivery-errors.mjs';
import { groupTaskAccess } from './group-policy.mjs';
import { groupTaskInstructions } from './group-task-instructions.mjs';
import { scopeId } from './policy.mjs';
import { RequestUpdates } from './request-updates.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { contentCodecs } from './content-codecs.mjs';
import './message-codecs.mjs';

// Shared message capture, serialization and feedback for immediate requests and scheduled turns.
// Entry policies retain their authorization, batching and completion semantics.
export class ConversationRequests {
  constructor(controller) { this.controller = controller; }
  queue(scope, execute, failed, settle) {
    const lane = this.controller.lane(scope);
    const task = lane.tail.then(execute).catch(failed).finally(settle);
    // A failed request or cleanup must never poison the next conversation task.
    lane.tail = task.catch(() => {});
    return task;
  }
  feedback(scope, requestId, settings, active, queued = false) {
    return new RequestUpdates(settings, response => this.controller.notifyAdmins({ scope, requestId,
      reason: 'TASK_FEEDBACK', text: response.text, feedback: true, isActive: response.isActive }), queued, active);
  }
  async capture(scope, message, isBotAdmin = null, historical = false) {
    const c = this.controller;
    message.images ??= await c.messageImages.capture(scope, message, historical);
    if (!message.structure) {
      message.structure = await c.messageRecords.capture(scope, message, isBotAdmin, historical);
      c.recordMessageElements(scope, message.requestId, message.structure);
    }
    return message.structure;
  }
  async enqueue({ who, message, text, reply, ignored }) {
    if (!who.private) throw new Error('FOREGROUND_PRIVATE_REQUIRED');
    const c = this.controller; const lane = c.lane(who.scope);
    if (lane.maintenance) { ignored('CONVERSATION_MAINTENANCE'); return; }
    const epoch = lane.epoch;
    const isCurrent = () => !c.closed && lane.epoch === epoch;
    const settings = who.admin ? await c.adminSettings.read(who.scope) : { toolMonitor: false };
    if (!isCurrent()) { ignored('ADMIN_CANCELLED'); return; }
    const updates = this.feedback(who.scope, message.requestId, settings, isCurrent, lane.pending > 0);
    clearTimeout(lane.timer); lane.timer = null;
    const entry = lane.events.add(`request:${message.messageId}`, 'message', async () => {
      if (!isCurrent()) throw new Error('EVENT_TURN_EXPIRED');
      const checkpoint = await c.store.conversation(who.scope);
      if (checkpoint.seen.includes(message.messageId)) return { alreadySeen: true, messageId: message.messageId };
      const { messageContent, currentSpeaker } = await this.prepare(who, message);
      return { messageId: message.messageId, messageContent, currentSpeaker };
    }, async () => {
      await c.recordModelInput(who.scope, [message.messageId]);
    });
    lane.pending++;
    c.debug.record(who.scope, 'task_queued', { requestId: message.requestId });
    c.emit('state', { scope: scopeId(who.scope), state: 'message_queued', requestId: message.requestId, pending: lane.pending });
    return this.queue(who.scope, async () => {
      if (!isCurrent()) { ignored('ADMIN_CANCELLED'); return; }
      if (entry.supplied) return;
      lane.events.remove(entry);
      const checkpoint = await c.store.conversation(who.scope);
      if (checkpoint.seen.includes(message.messageId)) { ignored('ALREADY_SEEN'); return; }
      c.emit('state', { scope: scopeId(who.scope), state: 'message_started', requestId: message.requestId });
      c.debug.record(who.scope, 'task_started', { requestId: message.requestId });
      updates.update({ kind: 'started' });
      const { messageImages, messageContent, currentSpeaker } = await this.prepare(who, message);
      await c.run(who.scope, text, checkpoint, { onUpdate: event => updates.update(event), isCurrent,
        onReply: (content, isActive, media, interaction) => reply({ event: 'reply-part', text: content, media, interaction, isActive: () => isCurrent() && isActive() }),
        messageContent, messageImages, requestId: message.requestId,
        currentSpeaker, inputMessageIds: [message.messageId] });
      await updates.finish();
    }, async error => {
      if (!isCurrent()) return;
      await updates.finish();
      await c.reportTaskFailure(who.scope, error, message.requestId);
    }, async () => {
      try { await updates.close(); }
      finally {
        lane.events.remove(entry);
        lane.pending--;
        if (!lane.pending) for (const scope of c.lanes.keys()) c.schedule(scope);
        if (!c.foregroundPending()) await c.groupScheduler.resume();
      }
    });
  }
  async prepare(who, message) {
    const c = this.controller;
    const record = await this.capture(who.scope, message, who.admin);
    await assertMessageAccess(who.scope, c.store, record);
    if (!await c.messageRecords.find(who.scope, record.messageId)) throw new Error('MESSAGE_NOT_RETAINED');
    return { messageImages: message.images, messageContent: contentCodecs.value('message.record', record).to('message.content').single(),
      currentSpeaker: { name: record.speaker?.name || '昵称未提供', openid: message.senderId, isBotAdmin: who.admin } };
  }
  async process(group, trigger) {
    const c = this.controller;
    if (c.acceptsChannelScope?.(`group:${group.openid}`) === false || c.draining || c.transportReady === false) return;
    const scope = `group:${group.openid}`;
    const lane = c.lane(scope);
    if (c.foregroundPending() || lane.pending || lane.active) {
      await c.groupContext.deferBatch(scope, 5000); return;
    }
    const requestId = randomUUID();
    const epoch = lane.epoch;
    let replies; let updates; let finishReason; let closed = false; let deliveryCurrent = () => true;
    const isActive = () => !closed && !c.closed && lane.epoch === epoch && !lane.active?.controller.signal.aborted && deliveryCurrent();
    await this.queue(scope, async () => {
      if (c.foregroundPending() || lane.pending) return;
      const current = await c.groupAccess.read(group.id);
      if (!isActive()) return;
      const access = groupTaskAccess(current, trigger.kind);
      if (!access.canRun) {
        c.debug.record(scope, 'group_task_skipped', { requestId, kind: trigger.kind, reason: access.reason });
        return;
      }
      if (trigger.kind === 'warmup' && !await c.groupContext.claimIdle(scope, trigger.quietAnchor)) return;
      if (trigger.kind !== 'warmup' && current.push) await c.groupAccess.update(group.id, item => { item.lastDiscoveryAt = Date.now(); });
      const wantsReply = trigger.kind === 'warmup' || trigger.kind === 'batch' && current.engage;
      const sendingBusy = access.reason === 'GROUP_SENDING_BUSY';
      const canReply = access.canReply;
      if (wantsReply && sendingBusy) {
        c.debug.record(scope, 'group_reply_skipped', { requestId, kind: trigger.kind, reason: access.reason });
        await c.groupContext.deferBatch(scope, 5000);
        return; // A temporary reservation must not consume an unanswered discussion batch.
      }
      if (canReply) replies = c.groupPublisher?.replies(group.id, trigger.kind === 'warmup' ? 'warmup' : 'chat',
        { requestId, scope, quietAnchor: trigger.quietAnchor, isActive,
          stopReason: () => c.closed || lane.epoch !== epoch ? 'ADMIN_CANCELLED' : lane.active?.interruptReason ?? 'REPLY_TURN_EXPIRED' });
      if (canReply && !replies) throw new Error('GROUP_REPLY_TRANSPORT_UNAVAILABLE');
      if (trigger.kind === 'batch' && current.toolMonitor === true && canReply) {
        updates = this.feedback(scope, requestId, { toolMonitor: true }, isActive);
        updates.update({ kind: 'started' }); await updates.pending;
      }

      const task = groupTaskInstructions(current, trigger, { canReply });
      c.debug.record(scope, 'batch_triggered', { requestId, reason: trigger.reason, kind: trigger.kind,
        count: trigger.status.pendingCount, chars: trigger.status.pendingChars });
      const result = await c.run(scope, task, await c.store.conversation(scope), { background: true, requestId, purpose: trigger.kind,
        isCurrent: isActive, onUpdate: event => updates?.update(event),
        ...(replies ? { onReply: (text, active, media, interaction) => replies.sendPart(text, active, media, interaction) } : {}),
      });
      if (!result) { finishReason = lane.interruptedWork.length ? 'NEW_MESSAGES' : 'MODEL_CANCELLED'; return; }
      await updates?.finish();
      deliveryCurrent = result.canFinishDelivery ?? (() => true);
      if (replies) replies.toolAttempts = result.replyAttempted ?? 0;
      if (result.replyDeliveryFailed) finishReason = 'SEND_TOOL_FAILED';
      if (wantsReply) c.debug.record(scope, 'group_reply_decision', { requestId, kind: trigger.kind,
        reason: result.replyAttempted ? 'MODEL_REPLY' : 'MODEL_SILENT' });
      if (!isActive()) {
        if ((replies?.sent ?? 0) > 0 && !c.closed && lane.epoch === epoch && !result.replyDeliveryFailed) {
          if (trigger.kind === 'batch') await c.groupContext.acknowledgeBatch(scope, result.groupRevision, result.groupEpoch);
        }
        c.debug.record(scope, 'group_reply_skipped', { requestId, reason: 'REPLY_TURN_EXPIRED' });
        return;
      }
      const sent = (replies?.sent ?? 0) > 0;
      if (!sent && !result.replyDeliveryFailed && !result.replyCurrentRejected && trigger.kind === 'discover' && isActive()) {
        const videos = (await c.store.memories(scope, 6)).filter(video => video.updatedAt >= result.startedAt);
        await c.groupPublisher?.deliver(group.id, videos, { requestId, isActive });
      }
      // This cursor records completed batches only. Input delivery is tracked
      // separately by exact IDs and never rolled back for a cancelled task.
      if (trigger.kind === 'batch' && (sent || isActive())) {
        await c.groupContext.acknowledgeBatch(scope, result.groupRevision, result.groupEpoch);
      }
      c.debug.record(scope, 'batch_finished', { requestId, kind: trigger.kind });
    }, async error => {
      if (!isActive()) return;
      if (replies?.reason === error.message || deliveryRateLimited(error)) return;
      finishReason = 'TASK_FAILED';
      lane.failures++;
      await c.groupContext.deferBatch(scope, Math.min(600000, 60000 * 2 ** Math.min(lane.failures - 1, 4)));
      await c.reportTaskFailure(scope, error, requestId);
    }, async () => {
      try { await updates?.close(); }
      finally { closed = true; replies?.close(c.closed || lane.epoch !== epoch ? 'ADMIN_CANCELLED' : finishReason); }
    });
    return { group: await c.store.read(c.groupAccess.path(group.id), group) };
  }
}
