// Application delivery boundary. A channel supplies the actual encoding and transport.
export class ChatDelivery {
  constructor({ transport, diagnostics, onState = () => {}, assertCanContinue, notifyAdmins, rememberReply, historyEpoch }) {
    if (typeof transport !== 'function') throw new Error('CHAT_TRANSPORT_REQUIRED');
    Object.assign(this, { transport, diagnostics, onState, assertCanContinue, notifyAdmins, rememberReply, historyEpoch });
  }
  async send(scope, content, { replyTarget, isActive, beforeSend = async () => {}, beforeCommit = beforeSend,
    onDispatch = () => {}, onStage = () => {}, notifyRateLimit = true, history = false } = {}) {
    const match = /^(group|c2c):([^\s:]{1,200})$/.exec(scope);
    if (!match) throw new Error('CONVERSATION_NOT_ALLOWED');
    const target = { scope: match[1], targetId: match[2] };
    if (replyTarget) {
      if (replyTarget.scope !== target.scope || replyTarget.targetId !== target.targetId) throw new Error('REPLY_TARGET_MISMATCH');
      Object.assign(target, replyTarget);
    }
    const { text = '', media, file, buttons, interaction } = typeof content === 'string' ? { text: content } : content;
    if (typeof text !== 'string' || [media, file, buttons, interaction].filter(Boolean).length > 1) throw new Error('REPLY_CONTENT_INVALID');
    if (interaction && text) throw new Error('REPLY_CONTENT_INVALID');
    if (!text.trim() && !media && !file && !buttons && !interaction) return { sent: false, skipped: true };
    const epoch = history ? this.historyEpoch?.(scope) : undefined;
    const check = async () => {
      if (isActive && !isActive()) throw new Error('REPLY_TURN_EXPIRED');
      await this.assertCanContinue(target);
      await interaction?.assertAccess(); await media?.assertAccess(); await file?.assertAccess?.();
    };
    // Channel adapters must await this guard again after acquisition/upload and
    // immediately before submission; they must never retry an uncertain send.
    const commit = async () => { await check(); await beforeCommit(); await check(); };
    let result;
    try {
      await check(); await beforeSend(); await check();
      result = await this.transport(target, { text, media, file, buttons, interaction }, { beforeCommit: commit, onDispatch, onStage });
    } catch (error) {
      if (!this.diagnostics.isRateLimited(error)) throw error;
      if (notifyRateLimit) await this.notifyAdmins({ scope, reason: 'QQ_RATE_LIMITED',
        text: '平台明确拒绝本次发送：限流。该消息未发送，未自动重试，任务保持启用。' });
      throw Object.assign(new Error('QQ_RATE_LIMITED'), this.diagnostics.errorDetails(error));
    }
    if (history && !interaction && this.rememberReply) {
      try { await this.rememberReply(scope, { text, media }, result, epoch); }
      catch {
        this.onState('reply_history_failed', { reason: 'REPLY_HISTORY_FAILED' });
        await this.notifyAdmins({ scope, reason: 'REPLY_HISTORY_FAILED' }).catch(() => {});
      }
    }
    return result;
  }
  async buttons(target, buttons, details, report) {
    this.onState('buttons_sending', details); const startedAt = Date.now();
    try {
      const result = await this.send(`${target.scope}:${target.targetId}`, { text: buttons.prompt ?? '可用指令：', buttons }, { replyTarget: target });
      this.onState('buttons_accepted', { ...details, elapsedMs: Date.now() - startedAt, hasMessageId: typeof result?.id === 'string' });
    } catch (error) { await report('buttons_failed', '操作指令发送失败', error, '可发送 /help 查看可用命令。'); }
  }
  async reportFailure(target, state, title, error, hint = '', details = {}) {
    this.onState(state, this.diagnostics.errorDetails(error));
    await this.notifyAdmins({ scope: `${target.scope}:${target.targetId}`, requestId: details.requestId,
      reason: state === 'reply_failed' ? 'QQ_REPLY_FAILED' : state,
      text: [title, hint, '需要帮助时，可在机管设置发送诊断报告。'].filter(Boolean).join('\n') });
  }
}
