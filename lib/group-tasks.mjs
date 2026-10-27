import { qqReplyLimited } from './qq-diagnostics.mjs';
import { groupTaskAccess } from './group-policy.mjs';
import { groupTaskInstructions } from './group-task-instructions.mjs';
import { RequestUpdates } from './request-updates.mjs';
import { randomUUID } from 'node:crypto';

// Coordinates one background group task; scheduling and delivery remain separate capabilities.
export class GroupTasks {
  constructor({ groups, context, store, lane, foregroundBusy, run, failure, debug, publisher, feedback, isOpen }) {
    Object.assign(this, { groups, context, store, lane, foregroundBusy, run, failure, debug, publisher, feedback, isOpen });
  }
  async process(group, trigger) {
    const scope = `group:${group.openid}`;
    const lane = this.lane(scope);
    if (this.foregroundBusy() || lane.pending || lane.active) {
      await this.context.deferBatch(scope, 5000); return;
    }
    const requestId = randomUUID();
    const epoch = lane.epoch;
    let replies; let updates; let finishReason; let closed = false; let deliveryCurrent = () => true;
    const isActive = () => !closed && this.isOpen() && lane.epoch === epoch && !lane.active?.controller.signal.aborted && deliveryCurrent();
    const work = lane.tail.then(async () => {
      if (this.foregroundBusy() || lane.pending) return;
      const current = await this.groups.read(group.id);
      if (!isActive()) return;
      const access = groupTaskAccess(current, trigger.kind);
      if (!access.canRun) {
        this.debug.record(scope, 'group_task_skipped', { requestId, kind: trigger.kind, reason: access.reason });
        return;
      }
      if (trigger.kind === 'warmup' && !await this.context.claimIdle(scope, trigger.quietAnchor)) return;
      if (trigger.kind !== 'warmup' && current.push) await this.groups.update(group.id, item => { item.lastDiscoveryAt = Date.now(); });
      const wantsReply = trigger.kind === 'warmup' || trigger.kind === 'batch' && current.engage;
      const sendingBusy = access.reason === 'GROUP_SENDING_BUSY';
      const canReply = access.canReply;
      if (wantsReply && sendingBusy) {
        this.debug.record(scope, 'group_reply_skipped', { requestId, kind: trigger.kind, reason: access.reason });
        await this.context.deferBatch(scope, 5000);
        return; // A temporary reservation must not consume an unanswered discussion batch.
      }
      if (canReply) replies = this.publisher()?.replies(group.id, trigger.kind === 'warmup' ? 'warmup' : 'chat',
        { requestId, scope, quietAnchor: trigger.quietAnchor, isActive,
          stopReason: () => !this.isOpen() || lane.epoch !== epoch ? 'ADMIN_CANCELLED' : lane.active?.interruptReason ?? 'REPLY_TURN_EXPIRED' });
      if (canReply && !replies) throw new Error('GROUP_REPLY_TRANSPORT_UNAVAILABLE');
      if (trigger.kind === 'batch' && current.toolMonitor === true && canReply) {
        updates = new RequestUpdates({ toolMonitor: true },
          response => this.feedback({ scope, requestId, reason: 'TASK_FEEDBACK', text: response.text,
            feedback: true, isActive: response.isActive }), false, isActive);
        updates.update({ kind: 'started' }); await updates.pending;
      }

      const task = groupTaskInstructions(current, trigger, { canReply });
      this.debug.record(scope, 'batch_triggered', { requestId, reason: trigger.reason, kind: trigger.kind,
        count: trigger.status.pendingCount, chars: trigger.status.pendingChars });
      const result = await this.run(scope, task, await this.store.conversation(scope), { background: true, requestId, purpose: trigger.kind,
        isCurrent: isActive, onUpdate: event => updates?.update(event),
        ...(replies ? { onReply: (text, active, media) => replies.sendPart(text, active, media) } : {}),
      });
      if (!result) { finishReason = lane.interruptedWork.length ? 'NEW_MESSAGES' : 'MODEL_CANCELLED'; return; }
      await updates?.finish();
      deliveryCurrent = result.canFinishDelivery ?? (() => true);
      if (replies) replies.toolAttempts = result.replyAttempted ?? 0;
      if (result.replyDeliveryFailed) finishReason = 'SEND_TOOL_FAILED';
      if (wantsReply) this.debug.record(scope, 'group_reply_decision', { requestId, kind: trigger.kind,
        reason: result.replyAttempted ? 'MODEL_REPLY' : 'MODEL_SILENT' });
      if (!isActive()) {
        if ((replies?.sent ?? 0) > 0 && this.isOpen() && lane.epoch === epoch && !result.replyDeliveryFailed) {
          if (trigger.kind === 'batch') await this.context.acknowledgeBatch(scope, result.groupRevision, result.groupEpoch);
        }
        this.debug.record(scope, 'group_reply_skipped', { requestId, reason: 'REPLY_TURN_EXPIRED' });
        return;
      }
      const sent = (replies?.sent ?? 0) > 0;
      if (!sent && !result.replyDeliveryFailed && !result.replyCurrentRejected && trigger.kind === 'discover' && isActive()) {
        const videos = (await this.store.memories(scope, 6)).filter(video => video.updatedAt >= result.startedAt);
        await this.publisher()?.deliver(group.id, videos, { requestId, isActive });
      }
      // This cursor records completed batches only. Input delivery is tracked
      // separately by exact IDs and never rolled back for a cancelled task.
      if (trigger.kind === 'batch' && (sent || isActive())) {
        await this.context.acknowledgeBatch(scope, result.groupRevision, result.groupEpoch);
      }
      this.debug.record(scope, 'batch_finished', { requestId, kind: trigger.kind });
    }).catch(async error => {
      if (!isActive()) return;
      if (replies?.reason === error.message || qqReplyLimited(error)) return;
      finishReason = 'TASK_FAILED';
      lane.failures++;
      await this.context.deferBatch(scope, Math.min(600000, 60000 * 2 ** Math.min(lane.failures - 1, 4)));
      await this.failure(scope, error, requestId);
    }).finally(async () => { await updates?.close(); closed = true; replies?.close(!this.isOpen() || lane.epoch !== epoch ? 'ADMIN_CANCELLED' : finishReason); });
    lane.tail = work.catch(() => {});
    await work;
    return { group: await this.store.read(this.groups.path(group.id), group) };
  }
}
