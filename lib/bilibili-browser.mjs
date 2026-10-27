import { stat } from 'node:fs/promises';
import { BilibiliPlayer, playerStage } from './bilibili-player.mjs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createBilibiliContext, bilibiliLoginState, statePath } from './bilibili-auth.mjs';
import { observeBilibiliSubtitles } from './bilibili-subtitles.mjs';

function validateBvid(bvid) {
  if (!/^BV[a-zA-Z0-9]{10}$/.test(bvid)) throw new Error('INVALID_BVID');
  return bvid;
}

async function extractCandidates(page) {
  await page.waitForSelector('a[href*="/video/BV"] h3, h3 a[href*="/video/BV"]');
  return page.locator('h3 a[href*="/video/BV"], a[href*="/video/BV"]:has(h3)').evaluateAll(links => {
    const found = new Map();
    for (const link of links) {
      const bvid = new URL(link.href).pathname.match(/\/(BV[a-zA-Z0-9]{10})(?:\/|$)/)?.[1];
      const title = (link.querySelector('h3') ?? link).textContent.trim();
      if (!bvid || !title || found.has(bvid)) continue;
      const card = link.closest('.bili-video-card');
      const duration = card?.querySelector('.bili-video-card__stats__duration')?.textContent.trim() ?? '';
      found.set(bvid, {
        id: `v${found.size + 1}`, bvid, title,
        author: card?.querySelector('.bili-video-card__info--author')?.textContent.trim() ?? null,
        duration_seconds: /^\d+(?::\d{2}){1,2}$/.test(duration)
          ? duration.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) : null,
        url: link.origin + link.pathname,
      });
    }
    return [...found.values()].slice(0, 20);
  });
}

export class BilibiliBrowser {
  constructor() { this.queue = Promise.resolve(); this.batches = new Map(); this.player = new BilibiliPlayer(); }
  run(task) {
    const pending = this.queue.then(task);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async start() {
    const revision = await stat(statePath).then(info => `${info.mtimeMs}:${info.size}`).catch(error => {
      if (error.code === 'ENOENT') return 'missing';
      throw error;
    });
    if (this.browser && this.authRevision === revision) return;
    if (this.browser) await this.close();
    this.authRevision = revision;
    this.browser = await chromium.launch({ headless: true });
    try {
      const { context, authenticated, savedSessionLoaded } = await createBilibiliContext(this.browser, {
        viewport: { width: 960, height: 720 }, acceptDownloads: false,
      });
      this.context = context;
      this.authenticated = authenticated;
      this.savedSessionLoaded = savedSessionLoaded;
    } catch (error) { await this.close(); throw error; }
  }
  async withPage(task, { blockMedia = false } = {}) {
    await this.start();
    const page = await this.context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(30_000);
    if (blockMedia) await page.route('**/*', route => {
      const request = route.request();
      return request.resourceType() === 'media' || /(^|\.)bilivideo\.(?:com|cn)$/.test(new URL(request.url()).hostname)
        ? route.abort() : route.continue();
    });
    try { return await task(page); } finally { await page.close(); }
  }
  discover(query = '') {
    return this.run(() => this.withPage(async page => {
      const response = await page.goto(query ? `https://search.bilibili.com/video?keyword=${encodeURIComponent(query)}` : 'https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) throw new Error(query ? 'SEARCH_UNAVAILABLE' : 'HOMEPAGE_UNAVAILABLE');
      const result = { list_id: randomUUID(), videos: await extractCandidates(page) };
      if (!result.videos.length) throw new Error('NO_CANDIDATES');
      this.batches.set(result.list_id, result.videos);
      if (this.batches.size > 3) this.batches.delete(this.batches.keys().next().value);
      return result;
    }));
  }
  select(listId, id) {
    const video = this.batches.get(listId)?.find(item => item.id === id);
    if (!video) throw new Error('CANDIDATE_BATCH_EXPIRED');
    return video;
  }
  subtitles(bvid) {
    validateBvid(bvid);
    return this.run(() => this.withPage(async page => {
      const read = observeBilibiliSubtitles(page);
      try {
        const response = await page.goto(`https://www.bilibili.com/zh-Hans/video/${bvid}/`, { waitUntil: 'domcontentloaded' });
        if (!response.ok()) throw new Error('VIDEO_PAGE_UNAVAILABLE');
        return { bvid, title: await page.title(), ...await read() };
      } finally { await page.close(); await read(); }
    }, { blockMedia: true }));
  }
  frame(bvid, seconds, options) {
    validateBvid(bvid);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('INVALID_TIMESTAMP');
    return this.run(async () => {
      try {
        await this.start();
        return await playerStage('PLAYER_SESSION', () => this.player.read(this.context, bvid, seconds, options));
      } catch (error) {
        if (this.context) error.bilibiliLoggedOut = await bilibiliLoginState(this.context).catch(() => null) === false;
        throw error;
      }
    });
  }
  async close() {
    await this.player.close();
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    if (browser) await browser.close();
  }
}
