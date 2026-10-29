import { randomUUID, createHash } from 'node:crypto';
import { action, controls, interaction } from './interaction.mjs';
import { assertDeliveryAccess } from './reply-access.mjs';
import { scopeId } from './policy.mjs';
import { groupLabel } from './group-label.mjs';
import { sharedRecord } from './context-access.mjs';

// Main-service owner for turn-local access to shared conversation evidence.
export class ChatContext {
  constructor(controller) { this.controller = controller; }
  async sharing(who, command) {
    if (!who.private || !who.scope.startsWith('c2c:')) return { text: '请在私聊中设置当前私聊是否共享上下文。' };
    const match = /^\/context-sharing(?: (on|off))?$/.exec(command);
    if (!match) return interaction('请发送下方指令进行设置。', [[action('共享上下文', '/context-sharing')]]);
    const settings = this.controller.adminSettings;
    if (match[1]) await settings.update(who.scope, value => {
      value.shareContext = match[1] === 'on'; value.sharingRevision++;
    });
    const value = await settings.read(who.scope);
    return interaction(`## 当前私聊上下文共享\n状态：${value.shareContext ? '开启' : '关闭'}\n\n开启后，其他已授权聊天中的模型（包括群聊）可以按需查询这段私聊保留的消息、图片、附件和机器人回复，包括开启前仍保留的内容。不会开放账号身份、凭据或项目文件。\n关闭后阻止后续读取；已经读入其他模型上下文或明确保存的副本无法撤回。\n此设置只影响当前私聊，不影响接收或发送消息。`, [
      [action(`${value.shareContext ? '关闭' : '开启'}共享`, `/context-sharing ${value.shareContext ? 'off' : 'on'}`)],
      ...(who.admin ? [[controls.chat]] : []),
    ]);
  }
  session(source, checkSource, requestId) {
    const c = this.controller; const targets = new Map(); const byScope = new Map();
    const salt = randomUUID();
    const checkGroup = async scope => {
      const group = await c.groupAccess.read(scopeId(scope));
      if (!group?.allowed || !group.listen || group.leftAt || group.taskBlocked) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
    };
    const checkTarget = async target => {
      await checkSource();
      await assertDeliveryAccess(target.scope, c);
      if (c.lane(target.scope).epoch !== target.epoch) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
      if (target.scope.startsWith('group:')) {
        await checkGroup(target.scope);
      } else {
        const contact = await c.replyContacts.get(target.scope);
        if (contact?.blocked || !contact && (c.lane(target.scope).paused || !c.admins.includes(target.scope.slice(4)))) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
        const settings = await c.adminSettings.read(target.scope);
        if (!settings.shareContext || settings.sharingRevision !== target.revision) throw new Error('CONTEXT_NOT_SHARED');
      }
    };
    const list = async ({ offset = 0, limit = 20 }) => {
      await checkSource();
      const candidates = (await c.groupAccess.records()).map(group => ({ scope: `group:${group.openid}`, kind: 'group', label: groupLabel(group) }));
      const privateScopes = new Set([...c.admins.map(id => `c2c:${id}`), ...(await c.replyContacts.records()).map(row => `c2c:${row.openid}`)]);
      candidates.push(...[...privateScopes].map((scope, i) => ({ scope, kind: 'private', label: `共享私聊 ${i + 1}` })));
      const available = [];
      for (const candidate of candidates) {
        if (candidate.scope === source || c.acceptsChannelScope?.(candidate.scope) === false) continue;
        const revision = candidate.kind === 'private' ? (await c.adminSettings.read(candidate.scope)).sharingRevision : null;
        const target = { ...candidate, epoch: c.lane(candidate.scope).epoch, revision };
        try { await checkTarget(target); }
        catch (error) {
          if (['CONTEXT_TARGET_UNAVAILABLE', 'CONTEXT_NOT_SHARED', 'GROUP_NOT_AUTHORIZED', 'CONVERSATION_MAINTENANCE'].includes(error.message)) continue;
          throw error;
        }
        let id = byScope.get(candidate.scope);
        const previous = targets.get(id);
        if (!previous || previous.epoch !== target.epoch || previous.revision !== target.revision) {
          id = `chat:${randomUUID()}`; byScope.set(candidate.scope, id); targets.set(id, target);
        }
        available.push({ id, kind: candidate.kind, label: candidate.label });
      }
      const items = available.slice(offset, offset + limit);
      for (const item of items) await checkTarget(targets.get(item.id));
      await checkSource();
      return { items, nextOffset: offset + items.length < available.length ? offset + items.length : null };
    };
    const execute = async (args, signal) => {
      if (!args || !['list', 'read', 'authorize', 'expand_forward'].includes(args.operation)
        || !Number.isInteger(args.offset) || args.offset < 0
        || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) throw new Error('CONTEXT_QUERY_INVALID');
      if (args.operation === 'list') return list(args);
      if (args.operation === 'expand_forward') {
        if (!/^forward:[a-f0-9]{32}$/.test(args.message_id ?? '')) throw new Error('CONTEXT_QUERY_INVALID');
        const target = args.target === 'current' ? null : targets.get(args.target);
        if (args.target !== 'current' && !target) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
        const scope = target?.scope ?? source;
        const check = async () => {
          if (signal?.aborted) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
          await checkSource();
          if (target) await checkTarget(target);
          else if (scope.startsWith('group:')) {
            await checkGroup(scope);
          }
        };
        await check();
        if (!c.readForward) throw new Error('FORWARD_ACQUISITION_UNAVAILABLE');
        const result = await c.readForward(scope, args.message_id, check, signal);
        await check();
        return result;
      }
      const target = targets.get(args.target);
      if (!target) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
      await checkTarget(target);
      if (args.operation === 'authorize') return { scope: target.scope };
      const page = await c.messageRecords.contextPage(target.scope, args);
      for (const item of page.items) {
        if (!await c.messageRecords.find(target.scope, item.id)) throw new Error('MESSAGE_NOT_RETAINED');
      }
      await checkTarget(target);
      return { target: args.target, items: page.items.map(item => ({ ...sharedRecord(item.record),
        timestamp: item.timestamp, receivedAt: new Date(item.received).toISOString(),
        speaker: item.record.source === 'bot_reply' ? { role: 'assistant' }
          : item.speaker ? { alias: `speaker:${createHash('sha256').update(`${salt}\0${target.scope}\0${item.speaker}`).digest('hex').slice(0, 16)}` } : null,
      })), nextOffset: page.nextOffset, untrusted: true,
      limitation: 'Retained conversation records, including accepted bot replies recorded since this feature was deployed. Not full QQ history. Use context_chat with message/image/audio/media/file tools for evidence. Offset pages may shift; reads do not consume input receipts.' };
    };
    return async (args, signal) => {
      try {
        if (signal?.aborted) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
        const result = await execute(args, signal);
        if (signal?.aborted) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
        return result;
      } catch (error) {
        if (!['CONTEXT_SOURCE_UNAVAILABLE', 'CONTEXT_TARGET_UNAVAILABLE', 'CONTEXT_NOT_SHARED', 'CONTEXT_QUERY_INVALID',
          'REPLY_TURN_EXPIRED', 'PRIVATE_CHAT_DISABLED', 'GROUP_NOT_AUTHORIZED', 'CONVERSATION_MAINTENANCE', 'MESSAGE_NOT_RETAINED',
          'FORWARD_REFERENCE_UNAVAILABLE', 'FORWARD_ACQUISITION_UNAVAILABLE', 'FORWARD_BODY_UNAVAILABLE', 'SNOWLUMA_CONNECTION_UNAVAILABLE'].includes(error.message)) {
          c.debug.record(source, 'chat_context_failed', { requestId, reason: 'CHAT_CONTEXT_FAILED' });
          await c.notifyAdmins({ scope: source, requestId, reason: 'CHAT_CONTEXT_FAILED' });
          throw new Error('CHAT_CONTEXT_FAILED');
        }
        throw error;
      }
    };
  }
}
