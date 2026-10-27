import { qqReplyLimited } from './qq-diagnostics.mjs';
import { groupTaskAccess } from './group-policy.mjs';
import { redactCredentials } from './policy.mjs';
import { SerialQueue } from './serial-queue.mjs';

const blockedCodes = new Set(['REPLY_TURN_EXPIRED', 'FOREGROUND_PRIORITY', 'GROUP_NOT_AUTHORIZED',
  'NEW_MESSAGES',
  'GROUP_SENDING_PAUSED', 'GROUP_SENDING_BUSY', 'COLLECTION_DISABLED',
  'WARMUP_DISABLED', 'NEW_GROUP_MESSAGE', 'ENGAGE_DISABLED']);

// One authorized conversation turn. Conversation replies preserve model message boundaries without local delays.
export class GroupReplies {
  constructor({ id, kind, requestId, quietAnchor, isActive, stopReason, scope, groups, context, send, diagnose, errorDetails, onState }) {
    Object.assign(this, { id, kind, requestId, quietAnchor, isActive, stopReason, scope, groups, context, send, diagnose, errorDetails, onState });
    this.queue = new SerialQueue(); this.requested = 0; this.sent = 0; this.failed = false; this.closed = false;
  }
  event(state, details = {}) {
    this.onState(state, { scope: this.scope, group: this.id, kind: this.kind, requestId: this.requestId,
      count: this.sent, attemptedCount: Math.max(this.requested, this.toolAttempts ?? 0), ...details });
  }
  async check(group, active, owner) {
    if (this.closed || !this.isActive() || active && !active()) throw new Error('REPLY_TURN_EXPIRED');
    const access = groupTaskAccess(group, this.kind === 'warmup' ? 'warmup' : 'batch', { owner });
    if (!access.canReply) throw new Error(access.reason);
    if (this.kind === 'warmup') {
      const status = await this.context.batchStatus(`group:${group.openid}`);
      if (status.lastMessageAt > this.quietAnchor) throw new Error('NEW_GROUP_MESSAGE');
    }
  }
  sendPart(text, active, media) {
    const content = redactCredentials(text);
    if (!content.trim() && !media) {
      this.event('reply_part_skipped', { reason: 'EMPTY_REPLY' });
      return Promise.resolve();
    }
    const part = ++this.requested;
    return this.queue.run(async () => {
      if (this.failed) throw new Error('GROUP_REPLY_SERIES_STOPPED');
      const owner = `${this.requestId}:${part}`;
      let reserved = false; let phase = 'reservation';
      try {
        const record = await this.groups.read(this.id);
        this.event('group_reply_queued');
        await this.groups.update(this.id, async group => {
          await this.check(group, active);
          group.pushPending = true; group.pushOwner = owner; reserved = true;
        });
        if (!reserved) return;
        phase = 'send';
        const beforeSend = async () => {
          const group = await this.groups.read(this.id);
          await this.check(group, active, owner);
          if (!group.pushPending || group.pushOwner !== owner) throw new Error('GROUP_SENDING_PAUSED');
        };
        await this.send(record.openid, content, { media, isActive: () => !this.closed && this.isActive() && (!active || active()),
          beforeSend, onDispatch: () => this.event('group_push_sending') });
        this.sent++;
        this.event('group_push_sent');
        phase = 'state';
        await this.groups.update(this.id, group => {
          if (group.pushOwner !== owner) return;
          group.pushPending = false; delete group.pushOwner;
          group.lastPushAt = new Date().toISOString();
        });
        if (this.closed) this.finishEvent();
      } catch (error) {
        if (qqReplyLimited(error)) {
          if (reserved) await this.groups.update(this.id, group => {
            if (group.pushOwner === owner) { group.pushPending = false; delete group.pushOwner; }
          });
          this.event('group_reply_rejected', { reason: 'QQ_RATE_LIMITED', ...this.errorDetails(error) });
          throw error;
        }
        this.failed = true;
        const code = error.message === 'REPLY_TURN_EXPIRED' && !this.isActive() ? this.finishReason ?? this.stopReason() : error.message;
        const blocked = blockedCodes.has(code);
        this.reason = blocked ? code : phase === 'send' ? 'QQ_PUSH_FAILED' : 'GROUP_REPLY_STATE_WRITE_FAILED';
        const diagnostic = blocked ? null : this.diagnose(error);
        this.event(blocked ? 'group_reply_skipped' : 'group_push_failed', {
          reason: this.reason, ...(diagnostic ? { diagnostic, ...this.errorDetails(error) } : {}) });
        if (reserved) await this.groups.update(this.id, group => {
          if (group.pushOwner !== owner) return;
          group.pushPending = false; delete group.pushOwner;
          if (diagnostic) group.pushError = diagnostic;
        });
        if (this.closed) this.finishEvent();
        throw new Error(this.reason);
      }
    });
  }
  close(reason) {
    this.closed = true; this.finishReason = reason; this.finishEvent();
  }
  finishEvent() {
    this.event('group_reply_finished', { reason: this.reason ?? this.finishReason ?? (this.sent ? 'SERIES_COMPLETE' : 'MODEL_SILENT') });
  }
}
