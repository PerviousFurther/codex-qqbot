// One retained player per MCP process. Each read returns one image immediately.
export async function playerStage(stage, action) {
  try { return await action(); }
  catch (error) {
    const known = String(error.message ?? '').match(/(?:^|[\s:])(FRAME_(?:TIMEOUT|TIMESTAMP_MISMATCH|CALLBACK_UNSUPPORTED)|PLAYER_(?:MEDIA_ERROR|DURATION_UNAVAILABLE))(?=$|\s)/)?.[1];
    const code = known ?? (/^[A-Z_]{3,80}$/.test(error.message) ? error.message
      : error.name === 'TimeoutError' ? `${stage}_TIMEOUT`
      : /net::ERR_|ECONNRESET|ETIMEDOUT/.test(error.message ?? '') ? 'BILIBILI_NETWORK_FAILED' : `${stage}_FAILED`);
    throw Object.assign(new Error(code), { accessibleRange: error.accessibleRange });
  }
}

export class BilibiliPlayer {
  async open(context, bvid) {
    if (this.page && !this.page.isClosed() && this.bvid === bvid) return;
    await this.close();
    this.page = await context.newPage(); this.bvid = bvid;
    const page = this.page;
    page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(30000);
    const response = await playerStage('PLAYER_PAGE', () => page.goto(`https://www.bilibili.com/zh-Hans/video/${bvid}/`, { waitUntil: 'domcontentloaded' }));
    if (!response?.ok()) throw new Error('VIDEO_PAGE_UNAVAILABLE');
    this.video = page.locator('video').first();
    await playerStage('PLAYER_LOADING', async () => {
      await this.video.waitFor();
      await this.video.evaluate(element => { element.muted = true; element.play().catch(() => {}); });
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        if (video?.error) throw new Error('PLAYER_MEDIA_ERROR');
        return video?.readyState >= 2;
      });
      await this.video.evaluate(element => element.pause());
    });
  }
  async read(context, bvid, seconds, { capture = true } = {}) {
    try {
      await this.open(context, bvid);
      const duration = await playerStage('PLAYER_METADATA', () => this.video.evaluate(element => element.duration));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('PLAYER_DURATION_UNAVAILABLE');
      // Only player UI is evidence of a preview limit; comments/description are not.
      const preview = await this.page.locator('.bpx-player-container, .bpx-player-primary-area').first().innerText({ timeout: 1500 }).catch(() => '');
      const limit = preview.match(/试看\s*(\d+)\s*秒/)?.[1];
      const end = limit ? Math.min(duration, Number(limit)) : duration;
      const range = { start_seconds: 0, end_seconds_exclusive: end, duration_seconds: duration,
        preview_limit_seconds: limit ? Number(limit) : null };
      if (seconds >= end) throw Object.assign(new Error('TIMESTAMP_OUTSIDE_ACCESSIBLE_RANGE'), { accessibleRange: range });
      const actual = await playerStage('FRAME_SEEK', () => this.video.evaluate((element, target) => new Promise((accept, reject) => {
        if (Math.abs(element.currentTime - target) < 0.01 && element.readyState >= 2) return accept(element.currentTime);
        if (typeof element.requestVideoFrameCallback !== 'function') return reject(new Error('FRAME_CALLBACK_UNSUPPORTED'));
        let callback;
        const finish = (error, value) => {
          clearTimeout(timer); element.removeEventListener('seeked', seeked);
          if (callback !== undefined) element.cancelVideoFrameCallback(callback);
          element.pause();
          if (error) reject(new Error(error)); else accept(value);
        };
        const timer = setTimeout(() => finish('FRAME_TIMEOUT'), 15000);
        const seeked = () => {
          callback = element.requestVideoFrameCallback((_, frame) => {
            finish(Math.abs(frame.mediaTime - target) > 0.3 ? 'FRAME_TIMESTAMP_MISMATCH' : null, frame.mediaTime);
          });
          element.muted = true; element.play().catch(() => {});
        };
        element.addEventListener('seeked', seeked, { once: true });
        element.currentTime = target;
        // A paused player need not present a new decoded frame. Run only until it does.
      }), seconds));
      const container = this.page.locator('.bpx-player-container, .bilibili-player').first();
      const visibleText = await playerStage('PLAYER_TEXT', () => container.evaluate(root => {
        const read = selector => {
          const result = []; let length = 0; let truncated = false;
          for (const node of root.querySelectorAll(selector)) {
            if (node.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) continue;
            const box = node.getBoundingClientRect(); const style = getComputedStyle(node);
            const bounds = root.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || !box.width || !box.height
              || box.right <= bounds.left || box.left >= bounds.right || box.bottom <= bounds.top || box.top >= bounds.bottom) continue;
            const value = node.textContent.trim().slice(0, 300);
            if (!value || result.includes(value)) continue;
            if (result.length >= 40 || length + value.length > 3000) { truncated = true; break; }
            result.push(value); length += value.length;
          }
          return { items: result, truncated };
        };
        return { danmaku: read('.bili-danmaku-x-dm, .b-danmaku, .bilibili-danmaku'),
          subtitles: read('.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle'),
          limitation: 'Only currently exposed visible DOM text at this timestamp, not complete danmaku history. Canvas-rendered, disabled, unloaded or absent overlays may yield no text; an empty list does not prove no comments exist.' };
      }));
      if (!capture) return { seconds: actual, visible_text: visibleText, accessible_range: range };
      const image = await playerStage('FRAME_CAPTURE', () => container.screenshot({ type: 'jpeg', quality: 75 }));
      if (image.length > 2 * 1024 * 1024) throw new Error('FRAME_TOO_LARGE');
      return { seconds: actual, image, visible_text: visibleText, capture: 'player_container', accessible_range: range };
    } catch (error) {
      if (error.message !== 'TIMESTAMP_OUTSIDE_ACCESSIBLE_RANGE') await this.close();
      throw error;
    }
  }
  async close() {
    const page = this.page;
    this.page = null; this.bvid = null; this.video = null;
    await page?.close().catch(() => {});
  }
}
