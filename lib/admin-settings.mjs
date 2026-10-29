import { join } from 'node:path';
import { scopeId } from './policy.mjs';
import { action, controls, interaction } from './interaction.mjs';

const durations = { any: '不限时长', short: '10 分钟以内', medium: '10～30 分钟', long: '30 分钟以上' };
const styles = ['综合探索', '冷知识与反直觉', '故事与人文', '深度分析', '轻松有趣'];
const clean = value => String(value ?? '').replace(/[\r\n*_`<>\[\]#]/g, ' ').slice(0, 200);
const tags = value => (Array.isArray(value) ? value : []).filter(item => typeof item === 'string')
  .map(item => item.trim().slice(0, 40)).filter(Boolean).slice(0, 12);
export const defaultPreferences = () => ({ topics: [], avoid: [], duration: 'any', style: styles[0] });

export class AdminSettings {
  constructor(store) { this.store = store; this.tail = Promise.resolve(); }
  path(scope) { return join(this.store.root, 'admin-settings', `${scopeId(scope)}.json`); }
  async read(scope) {
    const value = await this.store.read(this.path(scope), {});
    const preferences = value.preferences ?? {};
    return { shareContext: value.shareContext === true,
      sharingRevision: Number.isSafeInteger(value.sharingRevision) && value.sharingRevision >= 0 ? value.sharingRevision : 0,
      toolMonitor: value.toolMonitor === true,
      autobrowse: value.autobrowse === true, preferences: {
        topics: tags(preferences.topics), avoid: tags(preferences.avoid),
        duration: Object.hasOwn(durations, preferences.duration) ? preferences.duration : 'any',
        style: typeof preferences.style === 'string' ? preferences.style.slice(0, 200) : styles[0],
      } };
  }
  async update(scope, change) {
    const saved = this.tail.then(async () => {
      const settings = await this.read(scope);
      change(settings);
      await this.store.write(this.path(scope), settings);
    });
    this.tail = saved.catch(() => {});
    await saved;
  }
  async handle(scope, command) {
    const toggle = /^\/settings (toolMonitor|autobrowse) (on|off)$/.exec(command);
    if (toggle) await this.update(scope, settings => { settings[toggle[1]] = toggle[2] === 'on'; });
    else if (command.startsWith('/preferences')) return this.preferences(scope, command);
    else if (!/^\/settings(?: (chat|data|display|browsing))?$/.test(command)) return interaction('请选择要调整的设置。', [[controls.settings]]);
    await this.tail;
    const settings = await this.read(scope);
    const page = toggle ? toggle[1] === 'autobrowse' ? 'browsing' : 'display' : command.split(' ')[1];
    const enabled = value => value ? '开' : '关';
    if (page === 'display') return interaction(`## 运行反馈\n运行反馈：${enabled(settings.toolMonitor)}\n开启后，你会收到当前私聊任务的处理状态，以及查资料、读写文件和发送消息等操作的进展。群任务请在对应群设置中开启，反馈也只发给机管。\n反馈会说明正在做什么、是否完成和用时；不会展示聊天原文、文件内容或内部思考。\n需要排查问题时，统一发送下方的诊断报告。`, [
      [action(`${settings.toolMonitor ? '关闭' : '开启'}运行反馈`, `/settings toolMonitor ${settings.toolMonitor ? 'off' : 'on'}`)],
      [controls.debug], [controls.settings],
    ]);
    if (page === 'browsing') return interaction(`## 网页浏览\n自动找内容：${enabled(settings.autobrowse)}\n开启后按你的偏好寻找网页、视频和音频、保存摘要，不主动向私聊发送推荐。\n群里的内容分享请在群聊设置中开启。`, [
      [action(`${settings.autobrowse ? '关闭' : '开启'}自动找内容`, `/settings autobrowse ${settings.autobrowse ? 'off' : 'on'}`)],
      [controls.preferences], [action('网页访问权限', '/web-access')], [controls.settings],
    ]);
    if (page === 'chat') return interaction('## 私聊设置\n这里选择的模型只用于你与机器人的私聊。\n也可在这里设置是否接受其他人的私聊。', [
      [controls.models, controls.thinking], [action('运行反馈', '/settings display')],
      [action('私聊开放范围', '/chat-access'), action('共享私聊上下文', '/context-sharing')], [controls.settings],
    ]);
    if (page === 'data') return interaction('## 数据管理\n管理聊天记录、模型保存的文件与笔记，以及内容记录。\n清空数据前会再次确认。', [
      [action('聊天记录', '/memory'), action('内容记录', '/contents')],
      [action('文件与笔记', '/files'), action('附件与图片', '/media')], [controls.settings],
    ]);
    return interaction('## 机管设置\n选择要调整的内容。', [
      [controls.chat, controls.groups], [controls.persona, controls.preferences],
      [action('网页浏览', '/settings browsing'), action('数据管理', '/settings data')],
      [controls.cancel, action('运行反馈', '/settings display')],
    ]);
  }
  async preferences(scope, command) {
    const match = /^\/preferences(?: (topics|avoid|duration|style|reset)(?: ([\s\S]+))?)?$/.exec(command);
    if (!match) return interaction('偏好指令格式错误，请发送对应的偏好指令。', [[controls.preferences]]);
    const [, field, raw] = match;
    if (field === 'duration' && !raw) return interaction('## 视频时长\n优先推荐这个时长范围的视频。', [
      ...Object.entries(durations).map(([key, label]) => [action(label, `/preferences duration ${key}`)]), [controls.preferences],
    ]);
    if (field === 'style' && !raw) return interaction('## 内容风格\n选择一个偏好，也可发送 /preferences style 自定义说明。', [
      [action(styles[0], `/preferences style ${styles[0]}`), action(styles[1], `/preferences style ${styles[1]}`)],
      [action(styles[2], `/preferences style ${styles[2]}`), action(styles[3], `/preferences style ${styles[3]}`)],
      [action(styles[4], `/preferences style ${styles[4]}`)], [controls.preferences],
    ]);
    if (field && !raw && field !== 'reset') return interaction(
      field === 'topics' ? '请补充喜欢的主题后发送，例如：\n/preferences topics 科普、历史、独立游戏\n发送 /preferences topics 清空 可恢复不限主题。'
        : '请补充希望避开的内容后发送，例如：\n/preferences avoid 恐怖、剧透、广告\n发送 /preferences avoid 清空 可移除排除项。',
      [[action('编辑内容', `/preferences ${field}`, { enter: false })], [controls.preferences]]);
    let notice = '';
    if (field) {
      const value = raw?.trim();
      if (value?.length > 500 || field === 'duration' && !Object.hasOwn(durations, value)) {
        return interaction('偏好内容过长或时长选项无效，请重新设置。', [[controls.preferences]]);
      }
      await this.update(scope, settings => {
        if (field === 'reset') settings.preferences = defaultPreferences();
        else if (field === 'topics' || field === 'avoid') settings.preferences[field] = value === '清空' ? []
          : tags(value.split(/[，,、;；\n]+/));
        else settings.preferences[field] = value.slice(0, 200);
      });
      notice = field === 'reset' ? '偏好已恢复默认。\n\n' : '偏好已保存，下次选择内容时使用。\n\n';
    }
    await this.tail;
    const { preferences: p } = await this.read(scope);
    return interaction(`${notice}## 兴趣偏好\n喜欢：${p.topics.length ? p.topics.map(clean).join('、') : '不限主题'}\n`
      + `避开：${p.avoid.length ? p.avoid.map(clean).join('、') : '暂无排除项'}\n时长：${durations[p.duration]}\n风格：${clean(p.style)}\n\n`
      + '复制编辑指令，在末尾补充你喜欢或希望避开的内容后发送。', [
      [action('编辑主题', '/preferences topics', { enter: false }), action('编辑排除项', '/preferences avoid', { enter: false })],
      [action('视频时长', '/preferences duration'), action('内容风格', '/preferences style')],
      [action('恢复默认偏好', '/preferences reset')], [controls.settings],
    ]);
  }
}
