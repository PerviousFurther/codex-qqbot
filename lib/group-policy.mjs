const bounded = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;

// Shared execution/sending gates. Scheduler state never grants these permissions.
export function groupTaskAccess(group, kind, { owner } = {}) {
  const deny = reason => ({ canRun: false, canReply: false, reason });
  if (!group?.allowed || group.leftAt) return deny('GROUP_NOT_AUTHORIZED');
  if (group.taskBlocked) return deny('GROUP_SENDING_PAUSED');
  const busy = group.pushPending && (!owner || group.pushOwner !== owner);
  if (!['batch', 'warmup', 'discover'].includes(kind)) return deny('GROUP_TASK_INVALID');
  if (kind === 'discover') return group.push && !busy
    ? { canRun: true, canReply: false, reason: null } : deny(busy ? 'GROUP_SENDING_BUSY' : 'PUSH_DISABLED');
  if (!group.listen) return deny('COLLECTION_DISABLED');
  if (kind === 'warmup' && !groupPolicy(group).warmup) return deny('WARMUP_DISABLED');
  if (kind === 'warmup' && busy) return deny('GROUP_SENDING_BUSY');
  const reason = busy ? 'GROUP_SENDING_BUSY' : kind === 'batch' && !group.engage ? 'ENGAGE_DISABLED' : null;
  return { canRun: true, canReply: reason === null, reason };
}

export function groupPolicy(group) {
  const value = group.schedule ?? {};
  return { maxMessages: bounded(value.maxMessages, 20, 5, 500), maxChars: bounded(value.maxChars, 1000, 200, 20000),
    maxWaitSeconds: bounded(value.maxWaitSeconds, 180, 10, 3600),
    contextMinutes: bounded(value.contextMinutes, 10, 1, 1440),
    warmup: value.warmup === true, idleSeconds: bounded(value.idleSeconds, 3600, 60, 86400),
    enabledAt: Number.isFinite(value.enabledAt) ? value.enabledAt : Date.parse(group.observedAt) || Date.now() };
}

// Pure decision policy, shared by scheduling and the administrator diagnostics page.
export function groupDecision(group, status, now = Date.now()) {
  const policy = groupPolicy(group);
  if (!group.allowed || group.taskBlocked || !(group.listen || group.push)) return { kind: 'disabled', due: null, policy };
  const countReached = status.pendingCount >= policy.maxMessages;
  const charsReached = status.pendingChars >= policy.maxChars;
  const batchDue = group.listen && status.pendingCount ? Math.max(
    status.pendingMentions > 0 || countReached || charsReached ? now : status.lastMessageAt + policy.maxWaitSeconds * 1000,
    status.retryAt) : Infinity;
  const quietAnchor = Math.max(status.lastMessageAt, policy.enabledAt);
  const warmDue = group.listen && policy.warmup && !group.pushPending && status.idleReserved !== quietAnchor
    ? Math.max(quietAnchor + policy.idleSeconds * 1000, status.retryAt) : Infinity;
  const discoverDue = group.push && !group.pushPending
    ? Math.max((group.lastDiscoveryAt || 0) + 600000, group.nextPushAt || 0, status.retryAt) : Infinity;
  const candidates = [
    { kind: 'batch', due: batchDue, reason: status.pendingMentions > 0 ? 'mention' : charsReached ? 'chars' : countReached ? 'count' : 'wait' },
    { kind: 'warmup', due: warmDue, reason: 'idle', quietAnchor },
    { kind: 'discover', due: discoverDue, reason: 'video' },
  ].sort((a, b) => a.due - b.due);
  return Number.isFinite(candidates[0].due) ? { ...candidates[0], policy } : { kind: 'waiting', due: null, policy };
}
