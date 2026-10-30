import { deliveryRateLimited } from './delivery-errors.mjs';
import { randomUUID } from 'node:crypto';
import { groupLabel } from './group-label.mjs';
import { scopeId } from './policy.mjs';
import { assertDeliveryAccess, assertReplyAccess } from './reply-access.mjs';
import { snowRecipient } from './snowluma-identity.mjs';

// QQ selection resolves only this turn's authorized private recipient directory.
function privateQq(scope) {
  const match = /^c2c:sl~([1-9]\d{4,15})~([1-9]\d{4,15})$/.exec(scope);
  if (!match) return null;
  try { return String(snowRecipient(match[1], scope.slice(4))); }
  catch { return null; }
}

export class ReplyRouting {
  constructor(controller) { this.controller = controller; }
  async session(source, requestId, isActive, assertSource = async () => {}) {
    const c = this.controller;
    const targets = new Map();
    const privateTargets = new Map();
    const add = (id, scope, label, role) => {
      if (c.acceptsChannelScope?.(scope) === false) return;
      const qq = scope.startsWith('c2c:') ? privateQq(scope) : null;
      const target = { scope, label, role, ...(qq ? { qq } : {}), epoch: c.lane(scope).epoch };
      targets.set(id, target);
      if (qq) privateTargets.set(`qq:${qq}`, target);
    };
    const contacts = await c.replyContacts.records();
    const contactsByScope = new Map(contacts.map(contact => [`c2c:${contact.openid}`, contact]));
    for (const [index, openid] of c.admins.entries()) {
      const scope = `c2c:${openid}`;
      if (scope !== source && !contactsByScope.get(scope)?.blocked) add(`admin:${index + 1}`, scope, `机管私聊 ${index + 1}`, 'administrator');
    }
    for (const group of await c.groupAccess.records()) {
      const scope = `group:${group.openid}`;
      if (scope !== source && group.allowed && group.push && !group.taskBlocked && !group.pushPending) {
        add(`group:${group.id}`, scope, groupLabel(group), 'group');
      }
    }
    for (const contact of contacts) {
      const scope = `c2c:${contact.openid}`;
      if (scope !== source && !c.admins.includes(contact.openid) && !contact.blocked) {
        add(`private:${contact.id}`, scope, contact.name ? `私聊：${contact.name}` : `私聊 ${contact.id.slice(0, 6)}`, 'private_contact');
      }
    }
    const assert = async target => {
      await assertReplyAccess(source, c, isActive);
      await assertSource();
      await assertDeliveryAccess(target.scope, c, isActive);
      if (c.lane(target.scope).epoch !== target.epoch) throw new Error('REPLY_TURN_EXPIRED');
      if (target.scope.startsWith('c2c:')) {
        const contact = await c.replyContacts.get(target.scope);
        if (contact?.blocked || !c.admins.includes(target.scope.slice(4)) && !contact) throw new Error('REPLY_TARGET_NOT_ALLOWED');
      }
    };
    return {
      targets: [{ id: 'current', label: '当前对话' }, ...Array.from(targets, ([id, target]) => ({
        id, label: target.label, role: target.role, ...(target.qq ? { qq: target.qq } : {}),
      }))],
      send: async (id, text, media, stillActive = () => true) => {
        const sendingActive = () => isActive() && stillActive();
        const target = targets.get(id) ?? privateTargets.get(id);
        if (!target || !c.sendRoutedReply) throw new Error('REPLY_TARGET_NOT_ALLOWED');
        let reserved = false; let privateReserved = false; const owner = randomUUID();
        const groupId = target.scope.startsWith('group:') ? scopeId(target.scope) : null;
        const beforeCommit = async () => {
          if (!sendingActive()) throw new Error('REPLY_TURN_EXPIRED');
          await assert(target);
          if (groupId) {
            const group = await c.groupAccess.read(groupId);
            if (!group?.allowed || !group.push || group.taskBlocked || reserved && (!group.pushPending || group.pushOwner !== owner)) throw new Error('GROUP_SENDING_PAUSED');
          }
        };
        const beforeSend = async () => {
          await beforeCommit();
          if (groupId) {
            await c.groupAccess.update(groupId, group => {
              if (!group.allowed || !group.push || group.taskBlocked || group.pushPending) throw new Error('GROUP_SENDING_PAUSED');
              group.pushPending = true; group.pushOwner = owner; reserved = true;
            });
          } else {
            privateReserved = true;
          }
        };
        try {
          await c.sendRoutedReply(target.scope, text, sendingActive, beforeSend, media, beforeCommit);
          if (reserved) await c.groupAccess.update(groupId, group => { if (group.pushOwner !== owner) return; group.pushPending = false; delete group.pushOwner; });
          c.debug.record(source, 'routed_reply_sent', { requestId, kind: groupId ? 'group' : c.admins.includes(target.scope.slice(4)) ? 'admin' : 'private' });
        } catch (error) {
          if (reserved) await c.groupAccess.update(groupId, group => { if (group.pushOwner !== owner) return; group.pushPending = false; delete group.pushOwner; if (!deliveryRateLimited(error)) group.pushError = '跨对话发送失败或送达不确定，已停止任务'; });
          if (!deliveryRateLimited(error) && (reserved || privateReserved)) await c.stopConversation(target.scope, 'SEND_FAILED');
          c.debug.record(source, 'routed_reply_failed', { requestId, reason: /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'QQ_REPLY_FAILED' });
          throw error;
        }
      },
    };
  }
}
