import { qqReplyLimited } from './qq-diagnostics.mjs';
import { randomUUID } from 'node:crypto';
import { videoShare } from './history.mjs';
import { GroupReplies } from './group-replies.mjs';

// Shared group transport and durable reservations; chat parts have a turn-owned sender.
export class GroupPush {
  constructor(groups, context, send, diagnose, onState, errorDetails = () => ({})) {
    Object.assign(this, { groups, context, send, diagnose, onState, errorDetails });
  }
  replies(id, kind, metadata) {
    return new GroupReplies({ id, kind, ...metadata, groups: this.groups, context: this.context,
      send: this.send, diagnose: this.diagnose, onState: this.onState, errorDetails: this.errorDetails });
  }
  async deliver(id, videos, metadata = {}) {
    let text; let bvid; const owner = randomUUID();
    const record = await this.groups.update(id, group => {
      if (!group.allowed || !group.push || group.taskBlocked || group.pushPending
        || group.nextPushAt > Date.now()) return;
      const selected = videos.find(video => !(group.delivered ?? []).includes(video.bvid));
      if (!selected) return;
      bvid = selected.bvid; text = videoShare(selected);
      group.nextPushAt = Date.now() + 600000;
      group.delivered = [...(group.delivered ?? []), bvid];
      group.pushPending = true; group.pushOwner = owner;
    });
    if (!text) return false;
    const details = { scope: `group:${record.openid}`, group: id, kind: 'video', requestId: metadata.requestId };
    try {
      await this.send(record.openid, text, {
        isActive: metadata.isActive,
        beforeSend: async () => {
          const group = await this.groups.read(id);
          if (!group?.allowed || !group.push || group.taskBlocked || !group.pushPending || group.pushOwner !== owner) throw new Error('GROUP_SENDING_PAUSED');
        },
        onDispatch: () => this.onState('group_push_sending', details),
      });
      await this.groups.update(id, group => { if (group.pushOwner !== owner) return; group.pushPending = false; delete group.pushOwner; group.lastPushAt = new Date().toISOString(); });
      this.onState('group_push_sent', { ...details, bvid });
      return true;
    } catch (error) {
      const reason = qqReplyLimited(error) ? 'QQ_RATE_LIMITED' : ['REPLY_TURN_EXPIRED', 'GROUP_SENDING_PAUSED'].includes(error.message) ? error.message : 'QQ_PUSH_FAILED';
      const diagnostic = this.diagnose(error);
      await this.groups.update(id, group => { if (group.pushOwner !== owner) return; group.pushPending = false; delete group.pushOwner; if (reason === 'QQ_PUSH_FAILED') group.pushError = diagnostic; });
      this.onState(reason === 'QQ_PUSH_FAILED' ? 'group_push_failed' : 'group_reply_skipped',
        { ...details, reason, diagnostic, ...this.errorDetails(error) });
      return false;
    }
  }
}
