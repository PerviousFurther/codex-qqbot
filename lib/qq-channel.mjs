import { QQBot, messageFilter, mentionGate } from '@tencent-connect/qqbot-nodejs';
import { isCommandText } from './message-input.mjs';
import { normalizeQQMessage } from './message-elements.mjs';
import { randomUUID } from 'node:crypto';
import { QQDiagnostics } from './qq-diagnostics.mjs';
import { syncQQMenu } from './qq-ui.mjs';
import { QQDelivery } from './qq-delivery.mjs';
import { QQResponse } from './qq-response.mjs';
import { assertReplyAccess } from './reply-access.mjs';
import { AdminNotifications } from './admin-notifications.mjs';
import { BilibiliLogin } from './bilibili-login.mjs';

export class QQChannel {
  constructor({ appId, appSecret, transport = 'websocket', webhookPort = 8080, controller, store,
    menuEnabled = true, markdown = true, apiBaseUrl = 'https://api.bot.qq.com',
    onState = () => {} }) {
    if (!appId || !appSecret) throw new Error('QQ_CREDENTIALS_REQUIRED');
    if (menuEnabled && !store) throw new Error('QQ_MENU_STORE_REQUIRED');
    Object.assign(this, { controller, store, menuEnabled, onState });
    this.diagnostics = new QQDiagnostics(appSecret, onState);
    this.bot = new QQBot({ appId, appSecret, transport, baseUrl: apiBaseUrl,
      logger: this.diagnostics.logger,
      ...(transport === 'webhook' ? { webhook: { port: webhookPort, path: '/qq/callback' } } : {}) });
    this.delivery = new QQDelivery({ bot: this.bot, diagnostics: this.diagnostics, markdown, onState,
      notifyAdmins: report => controller.notifyAdmins(report),
      assertCanContinue: target => assertReplyAccess(`${target.scope}:${target.targetId}`, controller, () => !this.stopped) });
    this.notifications = new AdminNotifications(controller, this.delivery);
    controller.bilibiliLogin = new BilibiliLogin(controller, this.delivery);
    controller.notifyAdmins = async report => {
      await this.notifications.send(report);
      if (report.reason === 'BILIBILI_LOGIN_REQUIRED') await controller.bilibiliLogin.automatic();
    };
    this.bot.use(async (ctx, next) => {
      ctx.message.requestId = randomUUID();
      const details = { requestId: ctx.message.requestId, kind: ctx.message.kind,
        contentLength: ctx.message.content?.length ?? 0,
        ...(Number.isInteger(ctx.message.msgType) ? { messageType: ctx.message.msgType } : {}),
        elementCount: Array.isArray(ctx.message.msgElements) ? ctx.message.msgElements.length : 0 };
      const scope = ctx.message.kind === 'group' ? `group:${ctx.message.groupOpenid}` : `c2c:${ctx.message.senderId}`;
      this.controller.debug.record(scope, 'received', { ...details, inputChars: details.contentLength, eventType: ctx.message.rawEventType });
      this.onState('message_received', details);
      try { await next(); }
      finally {
        if (ctx.stopped) {
          if (ctx.message.kind === 'group' && ctx.stopReason === 'mention-gate:no_mention') {
            this.controller.debug.record(scope, 'ordinary_received', { requestId: details.requestId });
          }
          this.controller.debug.record(scope, 'filtered', { requestId: details.requestId, reason: ctx.stopReason });
          this.onState('message_filtered', { ...details, reason: ctx.stopReason });
        }
      }
    });
    this.bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 60000 } }));
    // Capture mention evidence before sanitization removes textual mention markers.
    this.bot.use(mentionGate({ requireMentionInGroup: true, passthrough: true }));
    this.bot.use(async (ctx, next) => {
      if (ctx.message.kind === 'group') ctx.message.botMentioned = ctx.state.mention.wasMentioned === true;
      normalizeQQMessage(ctx.message, this.bot.appId);
      await next();
    });
    this.bot.use(async (ctx, next) => {
      try { await this.controller.groupRuntime.observe(ctx.message); }
      catch (error) {
        const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message ?? '') ? error.message
          : /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code ?? '') ? error.code : 'GROUP_CONTEXT_WRITE_FAILED';
        this.controller.debug.record(`group:${ctx.message.groupOpenid}`, 'collection_failed', { requestId: ctx.message.requestId, reason });
        this.onState('group_collection_failed', { reason });
      }
      // All group discussion, including mentions, uses the collected batch path.
      if (ctx.message.kind === 'group' && !isCommandText(ctx.message.content)) {
        ctx.stop(ctx.message.botMentioned ? 'group-batch:mention' : `mention-gate:${ctx.state.mention.reason}`); return;
      }
      // Keep mentioned control commands on the authorized command path.
      if (ctx.message.kind === 'group' && !ctx.state.mention.shouldAnswer) {
        ctx.stop(`mention-gate:${ctx.state.mention.reason}`); return;
      }
      await next();
    });
    for (const event of ['ready', 'resumed']) this.bot.on(event, () => { onState('connected'); this.controller.debug.record('system', 'connected'); });
    this.bot.on('disconnected', () => { onState('disconnected'); this.controller.debug.record('system', 'disconnected'); });
    this.bot.on('error', () => { onState('error'); this.controller.debug.record('system', 'connection_error'); });
    this.bot.on('message', (_ctx, message) => this.handleMessage(message));
    this.bot.on('rawEvent', ctx => this.controller.groupLifecycle.handle(ctx));
  }

  async handleMessage(message) {
    if (!message.replyTarget?.msgId) {
      this.onState('message_ignored', { requestId: message.requestId, reason: 'MISSING_REPLY_TARGET' });
      return;
    }
    const response = new QQResponse({ message, delivery: this.delivery, debug: this.controller.debug, onState: this.onState });
    try { await this.controller.messages.handle(message, value => response.send(value)); }
    catch (error) { await response.handlerFailed(error); }
    finally {
      await response.finish();
      if (response.failed && message.kind === 'group') {
        const scope = `group:${message.groupOpenid}`;
        await this.controller.stopConversation(scope, 'SEND_FAILED')
          .catch(() => this.controller.debug.record(scope, 'task_stop_failed', { reason: 'STOP_FAILED' }));
      }
    }
  }

  async start(signal) {
    if (this.menuEnabled) {
      try { this.onState(await this.diagnostics.call(() => syncQQMenu(this.bot, this.store))); }
      catch (error) {
        this.onState('menu_failed', { reason: error.name === 'Error' ? error.message : 'QQ_MENU_UNAVAILABLE',
          ...this.diagnostics.errorDetails(error) });
      }
    }
    if (!this.stopped && !signal?.aborted) return this.bot.start(signal);
  }
  stop() { this.stopped = true; return this.bot.stop(); }
}
