import { deliveryRateLimited } from './delivery-errors.mjs';
import { SerialQueue } from './serial-queue.mjs';

// One incoming request owns its output queue and completion state.
export class ChatResponse {
  constructor({ message, delivery, debug, onState }) {
    Object.assign(this, { message, delivery, debug, onState });
    this.scope = message.kind === 'group' ? `group:${message.groupOpenid}` : `c2c:${message.senderId}`;
    this.details = { requestId: message.requestId }; this.startedAt = Date.now();
    this.queue = new SerialQueue(); this.closed = false; this.failed = false;
    this.replyParts = 0;
  }
  elapsed() { return Date.now() - this.startedAt; }
  trace(stage, metadata = {}) { this.debug.record(this.scope, stage, { ...this.details, ...metadata }); }
  target() { return this.message.replyTarget ?? {
    scope: this.message.kind === 'group' ? 'group' : 'c2c',
    targetId: this.message.kind === 'group' ? this.message.groupOpenid : this.message.senderId,
  }; }
  report(state, title, error, hint) { return this.delivery.reportFailure(this.target(), state, title, error, hint, this.details); }
  async publish(text, isActive, media, file, interaction) {
    if (!media && !file && !interaction && !text?.trim()) {
      this.trace('reply_part_skipped', { reason: 'EMPTY_REPLY' });
      return;
    }
    this.trace('qq_sending');
    await this.delivery.send(this.scope, { text, media, file, interaction }, { replyTarget: this.target(), isActive,
      history: this.modelReply === true && !interaction,
      onStage: stage => this.trace(stage) });
    this.replyParts++;
    const details = { elapsedMs: this.elapsed(), count: this.replyParts };
    this.trace('qq_accepted', details);
    this.onState('reply_accepted', { ...this.details, ...details });
  }
  async deliveryFailed(error, title) {
    this.failed = true;
    if (error.message === 'REPLY_TURN_EXPIRED') return;
    this.trace('qq_failed', this.delivery.diagnostics.errorDetails(error));
    await this.report('reply_failed', title, error);
  }
  send(value) {
    const response = typeof value === 'string' ? { text: value } : value;
    if (this.closed) return response.event === 'reply-part'
      ? Promise.reject(new Error('REPLY_TURN_EXPIRED')) : Promise.resolve();
    if (response.event === 'reply-part') return this.queue.run(() => this.part(response));
    if (response.event) return Promise.reject(new Error('QQ_RESPONSE_EVENT_UNSUPPORTED'));
    if (this.failed) { this.closed = true; return Promise.resolve(); }
    this.closed = true;
    return this.queue.run(() => this.command(response));
  }
  async part(response) {
    this.modelReply = true;
    if (this.failed) throw new Error('QQ_REPLY_FAILED');
    this.onState('reply_ready', { ...this.details, elapsedMs: this.elapsed() });
    // The reply bridge has resolved this text/media part; send it now.
    try { await this.publish(response.text, response.isActive, response.media, undefined, response.interaction); }
    catch (error) {
      if (deliveryRateLimited(error)) throw error;
      await this.deliveryFailed(error, '消息未能确认送达，后续发送已停止');
      throw new Error(error.message === 'REPLY_TURN_EXPIRED' ? 'REPLY_TURN_EXPIRED' : 'QQ_REPLY_FAILED');
    }
  }
  async command(response) {
    this.onState('reply_ready', { ...this.details, elapsedMs: this.elapsed(), buttons: !!response.buttons });
    const text = response.text ?? '';
    try {
      if (response.file) {
        await this.publish(text, response.isActive, undefined, response.file);
      } else if (response.media) {
        await this.publish(text, response.isActive, response.media);
      } else {
        await this.publish(text, response.isActive);
      }
    }
    catch (error) {
      if (deliveryRateLimited(error)) return { deliveryRejected: true };
      await this.deliveryFailed(error, response.file ? 'TXT 文件未能发送，已记录错误，请交给维护人员排查' : '回复发送失败');
      return { deliveryFailed: true };
    }
    if (response.buttons) await this.delivery.buttons(this.target(), response.buttons, this.details, (...args) => this.report(...args));
    return { deliveryFailed: false };
  }
  async handlerFailed(error) {
    const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? '') ? error.message
      : /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code ?? '') ? error.code : 'MESSAGE_HANDLER_FAILED';
    this.trace('message_handler_failed', { ...this.delivery.diagnostics.errorDetails(error), reason });
    this.onState('message_handler_failed', { ...this.details, ...this.delivery.diagnostics.errorDetails(error) });
    if (!this.closed) {
      this.closed = true;
      await this.queue.run(() => this.report('handler_reply_failed', '消息处理失败', error));
    }
  }
  async finish() {
    await this.queue.idle;
    this.onState(this.closed || this.replyParts > 0 || this.failed ? 'message_handled' : 'message_unanswered',
      { ...this.details, elapsedMs: this.elapsed() });
  }
}
