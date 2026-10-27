import { chromium } from 'playwright';
import qrcode from 'qrcode-generator';
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bilibiliLoginState, createBilibiliContext, statePath } from './bilibili-auth.mjs';

export const pendingLoginPath = `${dirname(statePath)}/qr-session.json`;

// Private service-side session. QR/key/cookies never pass through model tools or diagnostics.
export class BilibiliLoginSession {
  constructor(onPhase = () => {}) { this.onPhase = onPhase; }
  async step(phase, action) {
    if (this.phase !== phase) { this.phase = phase; this.onPhase(phase); }
    try { return await action(); }
    catch (error) {
      const code = /^BILIBILI_[A-Z_]{3,70}$/.test(error?.message ?? '') ? error.message
        : `${phase}_${error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED'}`;
      throw Object.assign(new Error(code), { ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) });
    }
  }
  async savePending() {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(pendingLoginPath, JSON.stringify({ key: this.key, expiresAt: this.expiresAt,
      storageState: await this.context.storageState() }), { mode: 0o600 });
  }
  async restore() {
    const pending = JSON.parse(await readFile(pendingLoginPath, 'utf8'));
    this.key = pending.key; this.expiresAt = pending.expiresAt;
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ storageState: pending.storageState });
  }
  async open() {
    this.browser = await this.step('BILIBILI_BROWSER_START', () => chromium.launch({ headless: true }));
    const existing = await this.step('BILIBILI_ACCOUNT_CHECK', () => createBilibiliContext(this.browser));
    if (existing.authenticated === true) return { status: 'authenticated' };
    await existing.context.close();
    this.context = await this.browser.newContext({ viewport: { width: 768, height: 768 }, acceptDownloads: false,
      javaScriptEnabled: false });
    const payload = await this.step('BILIBILI_QR_REQUEST', async () => {
      const response = await this.context.request.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
        timeout: 15000, headers: { Referer: 'https://www.bilibili.com/' },
      });
      if (!response.ok()) throw Object.assign(new Error('BILIBILI_QR_REQUEST_HTTP_ERROR'), { httpStatus: response.status() });
      const value = await response.json();
      if (value.code !== 0 || typeof value.data?.qrcode_key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.data.qrcode_key)
        || typeof value.data?.url !== 'string' || value.data.url.length > 2048) throw new Error('BILIBILI_QR_RESPONSE_INVALID');
      let url;
      try { url = new URL(value.data.url); }
      catch { throw new Error('BILIBILI_QR_URL_MALFORMED'); }
      if (url.protocol !== 'https:') throw new Error('BILIBILI_QR_URL_PROTOCOL_INVALID');
      if (url.hostname !== 'passport.bilibili.com' || url.username || url.password || url.port)
        throw new Error('BILIBILI_QR_URL_ORIGIN_INVALID');
      // The server supplies QR contents and the polling key as separate fields.
      // Encode the original URL unchanged; do not require a polling parameter in it.
      const urlKeys = url.searchParams.getAll('qrcode_key');
      if (urlKeys.some(key => key !== value.data.qrcode_key)) throw new Error('BILIBILI_QR_URL_KEY_MISMATCH');
      return value.data;
    });
    this.key = payload.qrcode_key; this.expiresAt = Date.now() + 180000;
    this.image = await this.step('BILIBILI_QR_RENDER', async () => {
      const qr = qrcode(0, 'M'); qr.addData(payload.url); qr.make();
      const page = await this.context.newPage();
      try {
        // Only locally generated SVG geometry is rendered. No login page, scripts or remote image service.
        await page.route('**/*', route => route.abort());
        await page.setContent(`<html><head><style>body{margin:0;background:white}svg{display:block}</style></head><body>${qr.createSvgTag(6, 24)}</body></html>`, { timeout: 10000 });
        return await page.locator('svg').screenshot({ type: 'png', animations: 'disabled', timeout: 10000 });
      } finally { await page.close(); }
    });
    if (this.image.length > 4 * 1024 * 1024) throw new Error('BILIBILI_QR_IMAGE_TOO_LARGE');
    return { status: 'waiting_for_scan', image: this.image };
  }
  async check(assertOwner = () => {}) {
    await assertOwner();
    if (!this.key || Date.now() >= this.expiresAt) return 'expired';
    const payload = await this.step('BILIBILI_QR_POLL', async () => {
      const response = await this.context.request.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll', {
        params: { qrcode_key: this.key }, timeout: 15000,
      });
      if (!response.ok()) throw Object.assign(new Error('BILIBILI_QR_POLL_HTTP_ERROR'), { httpStatus: response.status() });
      const value = await response.json();
      if (value.code !== 0) throw new Error('BILIBILI_QR_POLL_FAILED');
      return value;
    });
    const code = payload.data?.code;
    if (code === 86090) return 'awaiting_phone_confirmation';
    if (code === 86101) return 'waiting_for_scan';
    if (![0, 86038].includes(code)) throw new Error('BILIBILI_QR_STATUS_UNKNOWN');
    if (await this.step('BILIBILI_LOGIN_VERIFY', () => bilibiliLoginState(this.context)) !== true) {
      if (code === 86038) return 'expired';
      throw new Error('BILIBILI_LOGIN_VERIFICATION_FAILED');
    }
    await assertOwner();
    await this.step('BILIBILI_LOGIN_SAVE', async () => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
        const state = await this.context.storageState();
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await assertOwner();
        await rename(temporary, statePath);
      } finally { await rm(temporary, { force: true }); }
    });
    return 'authenticated';
  }
  async close() {
    this.key = null; this.image = null;
    const browser = this.browser; this.browser = null; this.context = null;
    await browser?.close().catch(() => {});
  }
}
