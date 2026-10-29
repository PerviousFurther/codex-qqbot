import { groupLabel } from './group-label.mjs';
import { action, controls, interaction } from './interaction.mjs';
import { numericSetting, settingNumber } from './numeric-setting.mjs';
import { groupPolicy } from './group-policy.mjs';

const fields = {
  chars: { key: 'maxChars', title: '累计字数', min: 200, max: 20000, presets: [500, 1000, 3000] },
  count: { key: 'maxMessages', title: '消息条数', min: 5, max: 500, presets: [10, 20, 50] },
  wait: { key: 'maxWaitSeconds', title: '群友停止发言后等待（秒）', min: 10, max: 3600, presets: [10, 60, 180, 600] },
  context: { key: 'contextMinutes', title: '新消息有效期（分钟）', min: 1, max: 1440, presets: [5, 10, 30] },
  idle: { key: 'idleSeconds', title: '冷场时间（秒）', min: 60, max: 86400, presets: [300, 3600, 7200] },
};

export class GroupSettings {
  constructor({ groups, changed, clear, status }) { Object.assign(this, { groups, changed, clear, status }); }
  async handle(text, adminScope) {
    if (text.startsWith('/groups')) return this.menu(text.split(/\s+/)[1]);
    const remark = /^\/group remark ([a-f0-9]{32})(?: ([^\r\n]+))?$/.exec(text);
    if (remark) {
      if (!remark[2]?.trim() || remark[2].trim().length > 60) return interaction('请填写 1～60 字的群备注；使用“清除备注”恢复平台群名。', [[action('返回群设置', `/group view ${remark[1]}`)]]);
      return this.detail(await this.groups.update(remark[1], group => { group.remark = remark[2].trim(); }));
    }
    const match = /^\/group (view|more|clear-remark|allow|deny|listen-on|listen-off|push-on|push-off|engage-on|engage-off|warmup-on|warmup-off|tool-monitor-on|tool-monitor-off|start|schedule) ([a-f0-9]{32})(?: (chars|count|wait|context|idle)(?: (\S+))?)?$/.exec(text);
    if (!match) return interaction('请通过群设置按钮操作。', [[controls.groups]]);
    const [, operation, id, field, raw] = match;
    let group = await this.groups.read(id);
    if (!group) throw new Error('GROUP_NOT_OBSERVED');
    if (operation === 'clear-remark') return this.detail(await this.groups.update(id, record => { delete record.remark; }));
    if (operation === 'more') return this.more(group);
    if (operation === 'view') return this.detail(group);
    if (operation === 'schedule' && !raw) return this.schedule(group, field);
    if (field && operation !== 'schedule') return interaction('设置指令格式错误。', [[controls.groups]]);
    if (raw && settingNumber(raw, fields[field]) === null) return this.schedule(group, field, `请输入 ${fields[field].min}～${fields[field].max} 的整数，原值未改动。`);
    if (['engage-on', 'warmup-on'].includes(operation) && !group.listen) return interaction('请先开启本群的群聊记录。', [[action('返回群设置', `/group view ${id}`)]]);
    group = await this.groups.update(id, record => {
      if (operation === 'allow') record.allowed = true;
      if (operation === 'deny') { record.allowed = false; record.listen = false; record.push = false; record.engage = false; record.schedule = { ...groupPolicy(record), warmup: false }; }
      if (operation !== 'tool-monitor-on' && (operation.endsWith('-on') || operation === 'start')) {
        if (!record.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
        record.ownerScope = adminScope; record.taskBlocked = null;
        record.pushPending = false; delete record.pushOwner;
      }
      if (operation.startsWith('tool-monitor-')) record.toolMonitor = operation === 'tool-monitor-on';
      if (operation.startsWith('listen-')) {
        record.listen = operation === 'listen-on';
        if (!record.listen) { record.engage = false; record.schedule = { ...groupPolicy(record), warmup: false }; }
      }
      if (operation.startsWith('push-')) record.push = operation === 'push-on';
      if (operation.startsWith('engage-')) record.engage = operation === 'engage-on';
      if (operation.startsWith('warmup-')) record.schedule = { ...groupPolicy(record), warmup: operation === 'warmup-on', enabledAt: Date.now() };
      if (operation === 'schedule') record.schedule = { ...groupPolicy(record), [fields[field].key]: Number(raw) };
    });
    if (operation === 'deny' || operation === 'listen-off') await this.clear(group);
    await this.changed();
    if (operation.startsWith('tool-monitor-')) return this.more(group);
    return operation === 'schedule' ? this.schedule(group, field, '已保存，仅影响本群。') : this.detail(group,
      operation === 'listen-on' ? '已开启本群的群聊记录。'
        : operation === 'start' ? '已启动，后续处理新内容，不补发之前失败的消息。' : '');
  }
  async detail(group, notice = '') {
    const id = group.id; const p = groupPolicy(group);
    const status = await this.status(group);
    const next = group.taskBlocked ? '自动任务已暂停，可点击恢复。' : status.running ? '正在参与群聊。'
      : status.busy ? '正在处理其他请求，自动任务稍后继续。'
      : group.listen ? '等待群里的新消息。' : '尚未开启群聊记录。';
    const on = value => value ? '开' : '关';
    const toggle = (name, enabled, command) => action(`${enabled ? '关闭' : '开启'}${name}`, `/group ${command}-${enabled ? 'off' : 'on'} ${id}`);
    return interaction(`## ${groupLabel(group)}\n群聊回复：${on(group.allowed)}\n群聊记录：${on(group.listen)} · 自动接话：${on(group.engage)}\n内容分享：${on(group.push)} · 冷场问候：${on(p.warmup)}\n\n${group.allowed ? next : '开启回复后，机器人才能在本群说话。'}${group.listen ? '\n关闭群聊记录或群聊回复，会清除本群的本地聊天记录、图片和笔记。' : ''}${notice ? `\n\n${notice}` : ''}`, [
      [action(group.allowed ? '关闭群聊回复' : '允许群聊回复', `/group ${group.allowed ? 'deny' : 'allow'} ${id}`),
        ...(group.allowed ? [action(group.taskBlocked ? '恢复自动任务' : '停止任务', group.taskBlocked ? `/group start ${id}` : `/stop ${id}`)] : [])],
      ...(group.allowed ? [[toggle('群聊记录', group.listen, 'listen'), toggle('自动接话', group.engage, 'engage')],
        [toggle('内容分享', group.push, 'push'), toggle('冷场问候', p.warmup, 'warmup')]] : []),
      [action('本群模型', `/group-models ${id}`)],
      [action('更多设置', `/group more ${id}`), action('返回群列表', '/groups')],
    ]);
  }
  more(group) {
    const id = group.id;
    return interaction(`## ${groupLabel(group)} · 更多设置\n接话节奏控制群消息何时交给模型，@ 机器人会立即触发。\n运行反馈开启后，你会在私聊收到本群任务的处理状态、查资料和读写文件等操作的进展及用时。反馈只发给机管，不展示聊天原文、文件内容或内部思考。\n发送失败或平台实际限流时会单独通知机管。`, [
      [action('接话节奏', `/group schedule ${id}`), action('思考深度', `/group-thinking ${id}`)],
      [action('聊天记录', `/group-memory ${id}`), action('文件与笔记', `/files ${id}`)],
      [action('设置群备注', `/group remark ${id} `, { enter: false }), ...(group.remark ? [action('清除备注', `/group clear-remark ${id}`)] : [])],
      [action('附件与图片', `/media ${id}`), action(`运行反馈：${group.toolMonitor === true ? '开' : '关'}`, `/group tool-monitor-${group.toolMonitor === true ? 'off' : 'on'} ${id}`)],
      [action('返回本群设置', `/group view ${id}`)],
    ]);
  }
  schedule(group, field, notice = '') {
    const id = group.id; const p = groupPolicy(group);
    if (field) {
      const spec = fields[field];
      return numericSetting({ environment: `${groupLabel(group)}，仅影响本群`, spec, current: p[spec.key],
        command: `/group schedule ${id} ${field}`, back: action('返回接话节奏', `/group schedule ${id}`), notice });
    }
    return interaction(`## ${groupLabel(group)} · 接话节奏\n@ 机器人会立即处理待接入的群消息；其他消息会先积累：群友停止发言 ${p.maxWaitSeconds} 秒后处理；积累到 ${p.maxMessages} 条或 ${p.maxChars} 字符也会提前处理。\n只主动接入 ${p.contextMinutes} 分钟内的新消息，已提供过的消息不重复推送。\n冷场问候需另行开启，安静 ${p.idleSeconds / 60} 分钟后最多尝试一次。`, [
      [action(`累计字数 ${p.maxChars}`, `/group schedule ${id} chars`), action(`消息条数 ${p.maxMessages}`, `/group schedule ${id} count`)],
      [action(`安静等待 ${p.maxWaitSeconds}秒`, `/group schedule ${id} wait`), action(`新消息有效期 ${p.contextMinutes}分钟`, `/group schedule ${id} context`)],
      [action(`冷场 ${p.idleSeconds / 60}分钟`, `/group schedule ${id} idle`)], [action('返回更多设置', `/group more ${id}`)],
    ]);
  }
  async menu(requestedPage = 1) {
    const records = await this.groups.records();
    if (!records.length) return interaction('先将机器人加入群，并在群里 @它发一条消息，再刷新。', [[action('刷新列表', '/groups'), controls.settings]]);
    const pages = Math.ceil(records.length / 4); const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
    const rows = records.slice((page - 1) * 4, page * 4).map(group => [action(groupLabel(group), `/group view ${group.id}`)]);
    const nav = [];
    if (page > 1) nav.push(action('上一页', `/groups ${page - 1}`));
    if (page < pages) nav.push(action('下一页', `/groups ${page + 1}`));
    nav.push(controls.settings); rows.push(nav);
    return interaction(`## 群聊设置（${page}/${pages}）\n${records.slice((page - 1) * 4, page * 4).map(group => `${groupLabel(group)}：${group.allowed ? '允许回复' : '尚未允许回复'}${group.taskBlocked ? ' · 自动任务已暂停' : ''}`).join('\n')}`, rows);
  }
}
