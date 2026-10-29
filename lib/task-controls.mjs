import { action, controls, interaction } from './interaction.mjs';
import { groupLabel } from './group-label.mjs';
import { scopeId } from './policy.mjs';

// Administrator-only UI; cancellation bypasses the target conversation's work queue.
export class TaskControls {
  constructor({ groups, contacts, lane, stop, accepts = () => true }) { Object.assign(this, { groups, contacts, lane, stop, accepts }); }
  async targets(adminScope) {
    return [{ id: scopeId(adminScope), scope: adminScope, name: '当前私聊' },
      ...(await this.contacts?.records() ?? []).filter(contact => `c2c:${contact.openid}` !== adminScope)
        .map(contact => ({ id: contact.id, scope: `c2c:${contact.openid}`, name: contact.name ? `私聊：${contact.name}` : `私聊 ${contact.id.slice(0, 6)}` })),
      ...(await this.groups.records()).map(group => ({ id: group.id, scope: `group:${group.openid}`, name: groupLabel(group) }))].filter(target => this.accepts(target.scope));
  }
  async handle(adminScope, text) {
    const match = /^\/stop(?: (all|[a-f0-9]{32}|page \d+))?$/.exec(text);
    if (!match) return interaction('请从停止回复页面选择对话。', [[controls.cancel, controls.settings]]);
    const targets = await this.targets(adminScope); const value = match[1];
    if (!value || value.startsWith('page ')) return this.menu(targets, value?.slice(5));
    const chosen = value === 'all' ? targets : targets.filter(target => target.id === value);
    if (!chosen.length) throw new Error('CONVERSATION_NOT_ALLOWED');
    await Promise.all(chosen.map(target => this.stop(target.scope)));
    return interaction(`${value === 'all' ? '所有对话' : chosen[0].name}：当前任务已停止，等待中的请求已取消，自动任务已暂停。\n发新消息仍可继续聊天。需要自动任务时，可到私聊或群聊设置中重新开启。`, [[controls.cancel, controls.settings]]);
  }
  menu(targets, rawPage) {
    const ranked = [...targets].sort((a, b) => {
      const busy = target => { const lane = this.lane(target.scope); return Number(!!lane.active || lane.pending > 0); };
      return busy(b) - busy(a);
    });
    const pages = Math.max(1, Math.ceil(ranked.length / 4));
    const page = Math.min(pages, Math.max(1, Number(rawPage) || 1));
    const selected = ranked.slice((page - 1) * 4, page * 4);
    const rows = selected.map(target => [action(`停止 ${target.name}`, `/stop ${target.id}`)]);
    const nav = [action('全部停止', '/stop all')];
    if (page > 1) nav.push(action('上一页', `/stop page ${page - 1}`));
    if (page < pages) nav.push(action('下一页', `/stop page ${page + 1}`));
    nav.push(controls.settings); rows.push(nav);
    const labels = selected.map(target => {
      const lane = this.lane(target.scope);
      return `${target.name}：${lane.active ? lane.active.background ? '自动任务进行中' : '正在回复' : lane.paused ? '已暂停' : '空闲'}`;
    });
    return interaction(`## 停止任务（${page}/${pages}）\n${labels.join('\n')}\n\n选择要停止的对话，已发出的消息不会撤回。`, rows);
  }
}
