import { BilibiliLoginSession } from './bilibili-login-session.mjs';
import { action, interaction } from './interaction.mjs';

export class BilibiliLogin {
  constructor(controller, delivery) {
    Object.assign(this, { controller, delivery });
    this.tail = Promise.resolve(); this.lastAutomatic = 0;
  }
  serial(action) {
    const pending = this.tail.then(action);
    this.tail = pending.catch(() => {});
    return pending;
  }
  assertOwner(owner) {
    if (this.controller.closed || !this.controller.admins.includes(owner)) throw new Error('ADMIN_ACCESS_REVOKED');
  }
  record(stage, reason, owner = this.owner) { this.controller.debug.record(owner ? `c2c:${owner}` : 'system', stage, { reason }); }
  errorReason(error) {
    return /^BILIBILI_[A-Z_]{3,70}$/.test(error?.message ?? '') ? error.message
      : error?.name === 'TimeoutError' ? 'BILIBILI_LOGIN_TIMEOUT' : 'BILIBILI_LOGIN_FAILED';
  }
  async dispose() {
    clearTimeout(this.timer); this.timer = null;
    const session = this.session; this.session = null; this.owner = null;
    await session?.close();
  }
  media(owner, session) {
    return { type: 'image', bytes: session.image,
      onStage: stage => this.record('bilibili_login_stage', stage, owner), assertAccess: async () => {
      this.assertOwner(owner);
      if (this.session !== session || session.expiresAt <= Date.now()) throw new Error('BILIBILI_QR_EXPIRED');
    } };
  }
  async begin(owner) {
    this.assertOwner(owner);
    if (this.session && this.session.expiresAt > Date.now()) {
      if (owner !== this.owner) return { text: '已有另一位机管正在登录，请等待完成或二维码过期后再试。' };
      return { text: '请用B站App扫描并在手机确认。二维码有效期约三分钟，确认后会自动保存；也可发送 /bilibili-login check 查看结果。',
        media: this.media(owner, this.session) };
    }
    await this.dispose();
    const session = new BilibiliLoginSession(phase => this.record('bilibili_login_stage', phase, owner)); this.session = session; this.owner = owner;
    try {
      const result = await session.open();
      this.assertOwner(owner);
      if (result.status === 'authenticated') {
        await this.dispose();
        return { text: 'B站已登录，可以继续看视频。' };
      }
      this.record('bilibili_login_qr_ready', 'WAITING_FOR_SCAN');
      this.schedule();
      return { text: '请用B站App扫描并在手机确认。二维码有效期约三分钟，确认后会自动保存；也可发送 /bilibili-login check 查看结果。',
        media: this.media(owner, session) };
    } catch (error) { await this.dispose(); throw error; }
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.serial(async () => {
        if (!this.session || this.controller.closed) return;
        const owner = this.owner;
        try {
          const result = await this.check(owner);
          if (result.done) await this.send(owner, result.text);
          else this.schedule();
        } catch (error) {
          this.record('bilibili_login_failed', this.errorReason(error), owner);
          await this.dispose();
          await this.send(owner, 'B站登录未完成，原登录状态保留。请从“视频浏览”重新获取登录二维码。');
        }
      });
    }, 3000);
    this.timer.unref();
  }
  async check(owner) {
    this.assertOwner(owner);
    if (!this.session) return { done: true, text: '当前没有等待确认的二维码，请发送 /bilibili-login 检查登录或获取二维码。' };
    if (this.owner !== owner) return { done: false, text: '已有另一位机管正在登录，请等待其操作完成。' };
    const state = await this.session.check(() => this.assertOwner(owner));
    if (state === 'authenticated' || state === 'expired') {
      this.record(state === 'authenticated' ? 'bilibili_login_saved' : 'bilibili_login_expired', state === 'authenticated' ? 'LOGIN_VERIFIED' : 'QR_EXPIRED');
      await this.dispose();
      return { done: true, text: state === 'authenticated'
        ? 'B站登录成功，可以继续看视频。'
        : '二维码已过期，请重新获取后扫码。' };
    }
    return { done: false, text: state === 'awaiting_phone_confirmation' ? '已扫码，请在手机B站App确认登录。' : '还在等待扫码，请用B站App扫描二维码。' };
  }
  async send(owner, text, media) {
    try {
      this.assertOwner(owner);
      await this.delivery.send(`c2c:${owner}`, { text, media }, { isActive: () => !this.controller.closed,
        beforeSend: async () => this.assertOwner(owner), beforeCommit: async () => this.assertOwner(owner), plain: true });
      this.record('bilibili_login_notice_sent', media ? 'QR_IMAGE' : 'LOGIN_STATUS', owner);
      return true;
    } catch (error) {
      this.controller.debug.record(`c2c:${owner}`, 'bilibili_login_notice_failed', { reason: 'QQ_LOGIN_NOTICE_FAILED',
        ...this.delivery.diagnostics.errorDetails(error) });
      return false;
    }
  }
  automatic() {
    return this.serial(async () => {
      if (this.controller.closed || this.session || Date.now() - this.lastAutomatic < 3600000) return;
      const owner = this.controller.admins[0];
      if (!owner) return;
      this.lastAutomatic = Date.now();
      try {
        const result = await this.begin(owner);
        if (!await this.send(owner, result.text, result.media)) await this.dispose();
      } catch (error) {
        this.record('bilibili_login_failed', this.errorReason(error), owner);
        await this.send(owner, '暂时无法获取B站登录二维码，请稍后在“视频浏览”中重试。');
      }
    });
  }
  handle(owner, text) {
    return this.serial(async () => {
      let result;
      try {
        if (text === '/bilibili-login check') result = await this.check(owner);
        else if (text === '/bilibili-login') result = await this.begin(owner);
        else result = { text: '请选择登录操作。' };
      } catch (error) {
        this.record('bilibili_login_failed', this.errorReason(error), owner);
        await this.dispose();
        result = { text: 'B站登录暂时未能完成，原登录状态保留。可稍后重试，或在机管设置发送诊断报告。' };
      }
      return { ...result, ...interaction(result.text, [
        [action('查看登录结果', '/bilibili-login check'), action('获取登录二维码', '/bilibili-login')],
        [action('返回视频浏览', '/settings browsing')],
      ]) };
    });
  }
  async close() { clearTimeout(this.timer); await this.serial(() => this.dispose()); }
}
