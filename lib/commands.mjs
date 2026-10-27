import { groupLabel } from './group-platform.mjs';
import { diagnosticReport } from './diagnostic-report.mjs';
import { action, controls, interaction, overview } from './interaction.mjs';
import { videoShare } from './history.mjs';
import { PRIVATE_REPLY, publicReply } from './policy.mjs';
import { isCommandText } from './message-input.mjs';

const help = '## 使用帮助\n直接聊天、发送视频链接，或说说你想看什么。\n\n浏览视频记录：/history\n查看当前状态：/status';

// Read-only pages and settings bypass inference; model/session changes use the task queue.
export class BotCommands {
  constructor(controller) {
    this.bot = controller;
    const page = (pattern, render, admin = true) => ({ pattern, admin, run: async context => context.reply(await render(context)) });
    // New commands register here; permission checks and matching stay in one place.
    this.routes = [
      page(/^\/stop(?:\s|$)/, ({ who, text }) => controller.taskControls.handle(who.scope, text)),
      page(/^\/manage$/, ({ who }) => controller.adminSettings.handle(who.scope, '/settings')),
      page(/^\/debug$/, ({ who }) => diagnosticReport(controller, who.scope)),
      page(/^\/bilibili-login(?:\s|$)/, ({ message, text }) => controller.bilibiliLogin.handle(message.senderId, text)),
      page(/^\/media(?:\s|$)/, ({ who, text }) => controller.mediaManagement.handle(who.scope, text)),
      page(/^\/files(?:\s|$)/, ({ who, text }) => controller.fileManagement.handle(who.scope, text)),
      page(/^\/videos(?:\s|$)/, ({ who, text }) => controller.videoCleanup.handle(who.scope, text)),
      page(/^\/(?:memory|group-memory)(?:\s|$)/, ({ who, text }) => controller.conversationMaintenance.handle(who.scope, text)),
      page(/^\/(?:reset|compact)$/, ({ who, text }) => controller.conversationMaintenance.handle(who.scope, text === '/reset' ? '/memory refresh' : '/memory compact')),
      page(/^\/chat-access(?:\s|$)/, ({ text }) => controller.chatAccess.handle(text)),
      { pattern: /^\/(?:thinking|group-thinking)(?:\s|$)/, admin: true, run: context => this.thinking(context) },
      { pattern: /^\/group-models?(?:\s|$)/, admin: true, run: context => this.groupModel(context) },
      page(/^\/persona(?:\s|$)/, ({ text }) => controller.personaSettings.handle(text)),
      { pattern: /^\/(?:settings|preferences)(?:\s|$)/, admin: true, run: context => this.settings(context) },
      page(/^\/groups(?:\s+\d+)?$|^\/group\s/, ({ who, text }) => controller.groupSettings.handle(text, who.scope)),
      page(/^\/history(?:\s+\d+)?$/, ({ text }) => controller.history.menu(text.split(/\s+/)[1]), false),
      { pattern: /^\/video (BV[a-zA-Z0-9]{10})$/, run: (context, match) => this.video(context, match[1]) },
      page(/^\/help$/, ({ who }) => overview(help + (who.admin && who.private ? '\n\n群聊、模型和其他管理功能，请打开“机管设置”：/settings' : ''), who.admin && who.private), false),
      { pattern: /^\/model\s+(\S+)$/, admin: true, run: ({ who, reply }, match) =>
        controller.changeConversation(who.scope, async () => reply(await controller.conversationModels.select(who.scope, match[1]))) },
      page(/^\/models(?:\s+\d+)?$|^\/model$/, ({ who, text }) => controller.conversationModels.menu(who.scope, text.split(/\s+/)[1])),
      { pattern: /^\/status$/, run: context => this.status(context) },
      { pattern: /^\/pause$/, admin: true, run: context => this.pause(context) },
    ];
  }
  async dispatch(context) {
    for (const route of this.routes) {
      const match = route.pattern.exec(context.text);
      if (!match) continue;
      if (route.admin && !(context.who.admin && context.who.private)) await context.reply(PRIVATE_REPLY);
      else await route.run(context, match);
      return true;
    }
    if (!isCommandText(context.text)) return false;
    // Unknown/malformed commands are local UI results, never model tasks.
    await context.reply(overview('未识别该命令。可发送 /help 查看帮助。', context.who.admin && context.who.private));
    return true;
  }
  async settings({ who, text, reply }) {
    const response = await this.bot.adminSettings.handle(who.scope, text);
    const toggle = /^\/settings autobrowse (on|off)$/.exec(text);
    if (toggle) this.bot.configureAutonomous(who.scope, toggle[1] === 'on');
    return reply(response);
  }
  async video({ who, reply }, bvid) {
    const bot = this.bot;
    const video = (await bot.history.records()).find(item => item.bvid === bvid);
    if (video) await bot.store.saveActivity(who.scope, { bvid: video.bvid, title: video.title });
    return reply(interaction(video ? `${videoShare(video)}\n\n可以直接发这条视频的链接和问题继续聊。` : '没有找到这条浏览记录。', [[controls.history, controls.watch]]));
  }
  async groupModel({ text, reply }) {
    const bot = this.bot;
    const match = /^\/(group-models|group-model) ([a-f0-9]{32})(?: (\S+))?$/.exec(text);
    if (!match) return reply(interaction('请从对应群的设置页选择模型。', [[controls.groups]]));
    const [, operation, id, value] = match;
    const group = await bot.groupAccess.read(id);
    if (!group) throw new Error('GROUP_NOT_OBSERVED');
    const scope = `group:${group.openid}`;
    const target = { list: `/group-models ${id}`, select: `/group-model ${id}`,
      thinking: `/group-thinking ${id}`,
      environment: groupLabel(group),
      back: action('返回群设置', `/group view ${id}`) };
    if (operation === 'group-models') return reply(await bot.conversationModels.menu(scope, value, target));
    return reply(await bot.changeConversation(scope, () => bot.conversationModels.select(scope, value, target)));
  }
  async thinking({ who, text, reply }) {
    const bot = this.bot;
    const match = /^\/(thinking|group-thinking)(?: (.*))?$/.exec(text);
    let scope = who.scope; let value = match?.[2] ?? '';
    let target = { thinking: '/thinking', environment: '当前私聊', back: controls.chat };
    if (match?.[1] === 'group-thinking') {
      const groupArgs = /^([a-f0-9]{32})(?: (.*))?$/.exec(value);
      if (!groupArgs) return reply(interaction('请从群设置选择思考深度。', [[controls.groups]]));
      const group = await bot.groupAccess.read(groupArgs[1]);
      if (!group) throw new Error('GROUP_NOT_OBSERVED');
      scope = `group:${group.openid}`; value = groupArgs[2] ?? '';
      target = { thinking: `/group-thinking ${group.id}`, environment: groupLabel(group), back: action('返回群设置', `/group view ${group.id}`) };
    }
    if (!value || /^page \d+$/.test(value)) return reply(await bot.conversationModels.thinkingMenu(scope, value.split(' ')[1], target));
    return reply(await bot.changeConversation(scope, () => bot.conversationModels.selectThinking(scope, value, target)));
  }
  async status({ who, reply }) {
    const lane = this.bot.lane(who.scope);
    const activity = await this.bot.store.activity(who.scope);
    const states = { idle: '空闲', responding: '正在回复', browsing: '正在浏览', paused: '已暂停', error: '出错' };
    return reply(overview(publicReply(`当前状态：${states[lane.state] ?? '处理中'}。\n${who.private ? '自动找视频' : '群自动任务'}：${lane.autobrowse ? '已开启' : '已关闭'}。\n${activity?.title ? `最近浏览：${activity.title}` : '还没有浏览记录。'}${lane.lastFailure ? '\n最近有任务未能完成，可稍后重试。' : ''}`), who.admin && who.private));
  }
  async pause({ who, reply }) {
    await this.bot.stopConversation(who.scope);
    return reply(interaction('已停止当前任务并暂停自动找视频。发新消息仍可继续聊天。', [[controls.chat, controls.settings]]));
  }

}
