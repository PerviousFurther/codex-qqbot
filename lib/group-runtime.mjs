import { groupDecision, groupTaskAccess, groupPolicy } from './group-policy.mjs';
import { isCommandText } from './message-input.mjs';
import { scopeId } from './policy.mjs';

// Group receipt/storage and runtime configuration, independent of model execution.
export class GroupRuntime {
  constructor(controller) { this.controller = controller; }
  bind(group) {
    const c = this.controller; const scope = `group:${group.openid}`; const lane = c.lane(scope);
    lane.autobrowse = !!(group.allowed && !group.leftAt && !group.taskBlocked && (group.listen || group.push));
    lane.paused = !lane.autobrowse;
    // Configuration changes revoke capabilities; the sender separately validates
    // reservation ownership. An active sender's own reservation is not a revocation.
    const permissionRecord = { ...group, pushPending: false };
    if (!groupTaskAccess(permissionRecord, 'batch').canReply) lane.events.active?.waiter?.cancel();
    if (!group.allowed || group.leftAt) {
      lane.events.close(); lane.interruptedWork = [];
      clearTimeout(lane.messageTimer); lane.messageTimer = null;
      if (lane.active) { lane.active.interruptReason = 'GROUP_NOT_AUTHORIZED'; lane.active.controller.abort(); }
    }
    if (!group.listen || !group.engage) for (const entry of lane.events.pending.values()) {
      if (entry.kind === 'group_batch') lane.events.remove(entry);
    }
    if (lane.active?.background && (lane.paused || !groupTaskAccess(permissionRecord, lane.active.purpose).canRun)) lane.active.controller.abort();
    if (!lane.active) c.state(scope, lane.paused ? 'paused' : 'idle');
  }
  async configure() {
    const c = this.controller; const groups = await c.groupAccess.records();
    for (const group of groups) this.bind(group);
    await c.groupScheduler.configure(groups);
  }
  async observe(message) {
    const c = this.controller;
    if (message.kind !== 'group' || !message.groupOpenid || !message.senderId || !message.messageId || message.senderIsBot) return;
    // Control commands are neither discussion input nor automatic-speech triggers.
    if (isCommandText(message.content)) return;
    await c.adminReady;
    const scope = `group:${message.groupOpenid}`;
    if (c.lane(scope).maintenance) return;
    const group = await c.groupAccess.observe(message.groupOpenid);
    let collected;
    await c.groupAccess.serial(async () => {
      const current = await c.store.read(c.groupAccess.path(group.id), null);
      if (!current?.allowed || current.leftAt || !current.listen || c.lane(scope).maintenance) return;
      message.images = await c.messageImages.capture(scope, message, true);
      message.structure = await c.messageRecords.capture(scope, message, null, true);
      c.recordMessageElements(scope, message.requestId, message.structure);
      await c.groupContext.append(message);
      collected = current;
    });
    if (collected) {
      this.bind(collected);
      c.debug.record(scope, 'message_collected', { requestId: message.requestId, inputChars: message.content?.length ?? 0 });
      await c.groupScheduler.observe(collected);
      await this.notifyEvents(scope);
    }
  }
  async notifyEvents(scope) {
    const c = this.controller; const lane = c.lane(scope); const turn = lane.events.active;
    clearTimeout(lane.messageTimer); lane.messageTimer = null;
    if (!turn || !turn.inputAccepted || !lane.active || lane.active.controller.signal.aborted || c.closed) return;
    const version = lane.eventVersion = (lane.eventVersion ?? 0) + 1;
    const group = await c.groupAccess.read(scopeId(scope));
    const access = groupTaskAccess({ ...group, pushPending: false }, 'batch');
    if (!access.canReply) return;
    const status = await c.groupContext.batchStatus(scope, { contextMinutes: groupPolicy(group).contextMinutes });
    if (lane.events.active !== turn || lane.eventVersion !== version) return;
    // Pending means not yet supplied, independent of reply/task completion.
    const decision = groupDecision({ ...group, push: false, schedule: { ...group.schedule, warmup: false } }, status);
    if (decision.kind !== 'batch' || decision.due === null) return;
    // An explicit wait accepts any new collected message, retaining retry/access gates.
    const waitingReply = turn.waiter && status.pendingCount > 0 && status.retryAt <= Date.now();
    if (decision.due > Date.now() && !waitingReply) {
      lane.messageTimer = setTimeout(() => this.notifyEvents(scope).catch(error => c.debug.record(scope, 'event_failed', { reason: 'EVENT_SCHEDULE_FAILED' })), Math.max(1, decision.due - Date.now()));
      lane.messageTimer.unref(); return;
    }
    if ([...lane.events.pending.values()].some(entry => entry.kind === 'group_batch' && !turn.taking.has(entry))) return;
    lane.events.add(`batch:${status.epoch}:${status.firstPendingRevision}:${status.latestRevision}`, 'group_batch', async () => {
      const current = await c.groupAccess.read(group.id);
      if (!groupTaskAccess({ ...current, pushPending: false }, 'batch').canReply) throw new Error('GROUP_NOT_AUTHORIZED');
      return c.groupContext.snapshot(scope, { batch: true, contextMinutes: groupPolicy(current).contextMinutes });
    }, snapshot => c.recordModelInput(scope, snapshot.messages.map(row => row.messageId), snapshot.epoch));
  }
  async clear(group) {
    await this.controller.chatRecords.clear(`group:${group.openid}`);
  }
  async status(group) {
    const c = this.controller; const scope = `group:${group.openid}`;
    const status = group.allowed && group.listen ? await c.groupContext.batchStatus(scope, { contextMinutes: groupPolicy(group).contextMinutes })
      : { pendingCount: 0, pendingChars: 0, firstPendingAt: 0, lastBatchAt: 0, lastMessageAt: 0, retryAt: 0, idleReserved: 0 };
    const data = c.debug.read(scope);
    return { ...status, decision: groupDecision(group, status), busy: c.foregroundPending(),
      running: !!c.lane(scope).active?.background,
      ordinaryObserved: !!data.counters?.ordinary_received || !!data.eventTypes?.GROUP_MESSAGE_CREATE };
  }
}
