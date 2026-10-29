import { randomBytes } from 'node:crypto';
import { action, controls, interaction } from './interaction.mjs';
import { groupLabel } from './group-label.mjs';
import { chatRecordView } from './chat-record-view.mjs';

// Shared administrator UI for private and group record/context maintenance.
export class ConversationMaintenance {
  constructor(controller) { this.controller = controller; this.confirmations = new Map(); }
  async handle(adminScope, text) {
    if (!adminScope.startsWith('c2c:') || !this.controller.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REQUIRED');
    const match = /^\/(memory|group-memory)(?: (.*))?$/.exec(text);
    let scope = adminScope; let value = match?.[2] ?? '';
    let command = '/memory'; let name = '当前私聊'; let group;
    let back = action('返回数据管理', '/settings data');
    if (match?.[1] === 'group-memory') {
      const args = /^([a-f0-9]{32})(?: (.*))?$/.exec(value);
      if (!args) return interaction('请从群的更多设置进入聊天记录。', [[controls.groups]]);
      group = await this.controller.groupAccess.read(args[1]);
      if (!group) throw new Error('GROUP_NOT_OBSERVED');
      scope = `group:${group.openid}`; value = args[2] ?? '';
      command = `/group-memory ${group.id}`; name = groupLabel(group);
      back = action('返回更多设置', `/group more ${group.id}`);
    }
    try {
      const records = await chatRecordView(this.controller, { adminScope, scope, group, name, command, value });
      if (records) return records;
    } catch (error) {
      if (error.message !== 'GROUP_MESSAGES_DISABLED') throw error;
      return interaction('本群当前未开放聊天记录访问，请检查群聊授权和记录开关。', [[back]]);
    }
    const key = `${adminScope}|${scope}`;
    for (const [id, pending] of this.confirmations) if (pending.until < Date.now()) this.confirmations.delete(id);
    if (value === 'clear') {
      const token = randomBytes(8).toString('hex');
      this.confirmations.set(key, { token, until: Date.now() + 600000 });
      return interaction(`## 清空聊天记录\n${name}\n将删除本对话在机器人中保存的消息、图片、笔记${group ? '和群聊摘要' : ''}，并开始新对话。此操作无法撤销。\n模型、角色和功能开关保留，不删除 QQ 客户端或服务商保存的记录。`, [
        [action('确认清空聊天记录', `${command} confirm ${token}`)], [action('取消', command)],
      ]);
    }
    let notice = '';
    if (value.startsWith('confirm ')) {
      const pending = this.confirmations.get(key); this.confirmations.delete(key);
      if (!pending || value !== `confirm ${pending.token}`) return this.page(name, command, back, '确认已失效，请重新选择清空。');
      await this.refresh(scope, group, true);
      notice = '已清空本地聊天记录，并开始新对话。';
    } else if (value === 'refresh') {
      await this.refresh(scope, group, false);
      notice = '已开始新对话，本地聊天记录保留。';
    } else if (value === 'compact') {
      const compacted = await this.controller.changeConversation(scope, () => this.controller.adapter.compact(scope));
      notice = compacted ? '已压缩当前对话，聊天记录保留。' : '当前没有可压缩的活动模型会话。';
    } else if (value) notice = '请发送下方对应的指令。';
    else this.confirmations.delete(key);
    return this.page(name, command, back, notice);
  }
  page(name, command, back, notice = '') {
    return interaction(`${notice ? `${notice}\n\n` : ''}## ${name} · 聊天记录\n开始新对话：停止当前任务，从新的对话开始，本地记录保留，不自动重推旧消息。\n整理对话：整理当前聊天内容，方便继续长对话，需等待当前任务结束。\n清空记录：删除机器人保存的本对话数据，需要再次确认。`, [
      [action('查看已保留消息', `${command} list`)],
      [action('开始新对话', `${command} refresh`), action('整理当前对话', `${command} compact`)],
      [action('清空聊天记录', `${command} clear`)], [back],
    ]);
  }

  async refresh(scope, group, clear) {
    const c = this.controller; const lane = c.lane(scope);
    if (lane.maintenance || c.closed) throw new Error('CONVERSATION_BUSY');
    lane.maintenance = true; lane.pending++; lane.epoch++;
    lane.events.close(); lane.interruptedWork = [];
    clearTimeout(lane.messageTimer); lane.messageTimer = null;
    clearTimeout(lane.timer); lane.timer = null;
    lane.active?.controller.abort();
    try {
      await c.adapter.reset(scope);
      const work = lane.tail.catch(() => {}).then(async () => {
        if (group && !await c.groupAccess.read(group.id)) throw new Error('GROUP_NOT_OBSERVED');
        // A preparation already in progress can finish opening a session during cancellation.
        await c.adapter.reset(scope);
        const checkpoint = await c.store.conversation(scope);
        checkpoint.threadId = null;
        await c.store.saveConversation(scope, checkpoint);
        const erase = async () => {
          await c.chatRecords.clear(scope);
        };
        if (clear) {
          if (group) await c.groupAccess.serial(erase); else await erase();
        }
        c.debug.record(scope, clear ? 'chat_records_cleared' : 'context_refreshed');
      });
      lane.tail = work.catch(() => {});
      await work;
    } finally {
      lane.maintenance = false; lane.pending--;
      if (!c.closed) {
        await c.groupRuntime.configure();
        c.schedule(scope);
        await c.groupScheduler.resume();
      }
    }
  }
}
