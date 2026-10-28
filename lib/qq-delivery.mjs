import { markdownUnsupported, qqReplyLimited } from './qq-diagnostics.mjs';
import { commandKeyboard } from './qq-ui.mjs';
import { ProactiveQueue } from './proactive-queue.mjs';

// QQ transport policy shared by plain replies, model fragments and management UI.
export class QQDelivery {
  constructor({ bot, diagnostics, markdown, onState, assertCanContinue, notifyAdmins, rememberReply, historyEpoch }) {
    Object.assign(this, { bot, diagnostics, markdown, onState, assertCanContinue, notifyAdmins, rememberReply, historyEpoch });
    this.plainTextTargets = new Set(); this.proactive = new ProactiveQueue();
  }
  supportsMarkdown(target) {
    return this.markdown && !this.plainTextTargets.has(`${target.scope}:${target.targetId}`);
  }
  _call(target, operation, isActive, { notifyRateLimit = true } = {}) {
    const call = async () => {
      if (isActive && !isActive()) throw new Error('REPLY_TURN_EXPIRED');
      return this.diagnostics.call(operation);
    };
    const pending = target.msgId ? call() : this.proactive.run(target, async () => {
      await this.assertCanContinue(target);
      return call();
    });
    // Report after releasing the shared proactive queue: administrator delivery uses it too.
    return pending.catch(async error => {
      if (qqReplyLimited(error)) throw await this.rateLimit(target, error, notifyRateLimit);
      throw error;
    });
  }
  async rateLimit(target, error, notify = true) {
    if (notify) await this.notifyAdmins({ scope: `${target.scope}:${target.targetId}`, reason: 'QQ_RATE_LIMITED',
      text: this.diagnostics.format('QQ 明确拒绝本次发送：平台限流。该消息未发送，未自动重试，任务保持启用。', error) });
    return Object.assign(new Error('QQ_RATE_LIMITED'), this.diagnostics.errorDetails(error),
      Number(error.bizCode) === 22009 ? { bizCode: 22009 } : {});
  }
  async send(scope, content, { replyTarget, isActive, beforeSend = async () => {}, beforeCommit = beforeSend,
    onDispatch = () => {}, onStage = () => {}, plain = false, notifyRateLimit = true, history = false } = {}) {
    const match = /^(group|c2c):([^\s:]{1,200})$/.exec(scope);
    if (!match) throw new Error('CONVERSATION_NOT_ALLOWED');
    const target = { scope: match[1], targetId: match[2] };
    if (replyTarget) {
      if (replyTarget.scope !== target.scope || replyTarget.targetId !== target.targetId) throw new Error('REPLY_TARGET_MISMATCH');
      Object.assign(target, replyTarget);
    }
    const { text = '', media, file, buttons } = typeof content === 'string' ? { text: content } : content;
    if (typeof text !== 'string' || [media, file, buttons].filter(Boolean).length > 1) throw new Error('REPLY_CONTENT_INVALID');
    if (!text.trim() && !media && !file && !buttons) return { sent: false, skipped: true };
    const epoch = history ? this.historyEpoch?.(scope) : undefined;
    let downgraded = false;
    try {
      const result = await this._call(target, async () => {
        const check = async () => {
          if (isActive && !isActive()) throw new Error('REPLY_TURN_EXPIRED');
          await this.assertCanContinue(target);
        };
        await check(); await beforeSend(); await check();
        if (file) return this._sendFile(target, text, file, isActive, onStage, beforeCommit, onDispatch);
        if (media) return this._sendMedia(target, text, media, isActive, beforeCommit, onDispatch);
        await beforeCommit(); await check(); onDispatch();
        if (!plain && this.supportsMarkdown(target)) {
          try {
            return await this.diagnostics.call(() => this.bot.sendMarkdown(target, text,
              buttons ? { keyboard: commandKeyboard(buttons, { autoSend: target.scope === 'c2c' }) } : undefined));
          } catch (error) {
            if (!markdownUnsupported(error)) throw error;
            this.plainTextTargets.add(scope); downgraded = true;
            this.onState('markdown_disabled', { scope: target.scope, ...this.diagnostics.errorDetails(error) });
            await beforeCommit(); await check();
          }
        }
        const body = text + (buttons ? '\n可用操作（请发送对应指令）：\n' + buttons.rows.flat()
          .map(item => `${item.label}：${item.command}`).join('\n') : '');
        return this.bot.sendText(target, body);
      }, isActive, { notifyRateLimit });
      if (history && this.rememberReply) {
        try { await this.rememberReply(scope, { text, media }, result, epoch); }
        catch {
          this.onState('reply_history_failed', { reason: 'REPLY_HISTORY_FAILED' });
          await this.notifyAdmins({ scope, reason: 'REPLY_HISTORY_FAILED' }).catch(() => {});
        }
      }
      return result;
    } finally {
      // Report after the shared queue releases; notification itself uses send().
      if (downgraded && notifyRateLimit) await this.notifyAdmins({ scope, reason: 'MARKDOWN_UNSUPPORTED',
        text: '当前对话暂不支持富文本，已改为普通文字。' });
    }
  }
  async buttons(target, buttons, details, report) {
    const startedAt = Date.now(); this.onState('buttons_sending', details);
    try {
      const prompt = buttons.prompt + (target.scope === 'group' ? '\n点击按钮填入指令后，请手动发送。' : '');
      const result = await this.send(`${target.scope}:${target.targetId}`, { text: prompt, buttons }, { replyTarget: target });
      this.onState('buttons_accepted', { ...details, elapsedMs: Date.now() - startedAt, hasMessageId: typeof result?.id === 'string' });
    } catch (error) { await report('buttons_failed', '操作按钮发送失败', error, '可发送 /help 查看可用命令。'); }
  }
  async reportFailure(target, state, title, error, hint = '', details = {}) {
    this.onState(state, this.diagnostics.errorDetails(error));
    await this.notifyAdmins({ scope: `${target.scope}:${target.targetId}`, requestId: details.requestId,
      reason: state === 'reply_failed' ? 'QQ_REPLY_FAILED' : state,
      text: [title, hint, ...(!error.diagnosticStage ? ['需要帮助时，可在机管设置发送诊断报告。'] : [])].filter(Boolean).join('\n') });
  }
  async _sendMedia(target, text, media, isActive, beforeCommit = async () => {}, onDispatch = () => {}) {
    const check = async () => {
      if (isActive && !isActive()) throw new Error('REPLY_TURN_EXPIRED');
      await this.assertCanContinue(target);
      await media.assertAccess();
      await beforeCommit();
    };
    await check();
    // Uploading does not send a message. Recheck cancellation/access before the actual send.
    media.onStage?.('MEDIA_UPLOAD');
    const upload = await this.diagnostics.call(() => this.bot.uploadMedia({ target,
      fileType: { image: 1, video: 2, audio: 3 }[media.type], buffer: media.bytes, srvSendMsg: false }));
    if (typeof upload?.file_info !== 'string' || !upload.file_info) throw new Error('QQ_MEDIA_UPLOAD_INVALID');
    await check();
    media.onStage?.('MEDIA_SEND');
    onDispatch();
    const result = await this.diagnostics.call(() => this.bot.send({ target, msgType: 7,
      media: { file_info: upload.file_info }, ...(text ? { content: text } : {}) }));
    media.onStage?.('MEDIA_ACCEPTED');
    return result;
  }
  async _sendFile(target, text, file, isActive, onStage, beforeCommit, onDispatch) {
    // Generated TXT exports stay in private chat.
    if (target.scope !== 'c2c' || !/^[a-zA-Z0-9_.-]{1,120}\.txt$/.test(file.name)
      || typeof file.text !== 'string' || Buffer.byteLength(file.text, 'utf8') > 512 * 1024) throw new Error('INVALID_DIAGNOSTIC_FILE');
    const check = async () => {
      if (isActive && !isActive()) throw new Error('REPLY_TURN_EXPIRED');
      await this.assertCanContinue(target);
      await beforeCommit();
      await file.assertAccess?.();
    };
    await check();
    // The SDK's small-file wrapper currently drops fileName; use its authenticated API gateway.
    onStage('diagnostic_file_upload');
    let upload;
    try {
      upload = await this.diagnostics.call(() => this.bot.api.post(`/v2/users/${encodeURIComponent(target.targetId)}/files`, {
        file_type: 4, file_name: file.name, file_data: Buffer.from(file.text, 'utf8').toString('base64'), srv_send_msg: false,
      }));
    } catch (error) { error.diagnosticStage = 'file_upload'; throw error; }
    onStage('diagnostic_file_uploaded');
    if (typeof upload?.file_info !== 'string' || !upload.file_info) throw new Error('QQ_FILE_UPLOAD_INVALID');
    await check();
    onStage('diagnostic_file_send');
    onDispatch();
    try {
      const result = await this.diagnostics.call(() => this.bot.send({ target, msgType: 7,
        media: { file_info: upload.file_info }, ...(text ? { content: text } : {}) }));
      onStage('diagnostic_file_sent');
      return result;
    } catch (error) { error.diagnosticStage = 'file_send'; throw error; }
  }

}
