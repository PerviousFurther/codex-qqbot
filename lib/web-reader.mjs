import { chromium } from 'playwright';
import { SerialQueue } from './serial-queue.mjs';
import { downloadPublicResource, validatePublicURL } from './public-resource.mjs';

const MAX_TEXT = 200000;
export class WebReader {
  constructor() { this.queue = new SerialQueue(); this.cache = new Map(); }
  read(url, offset, limit) { return this.queue.run(() => this.readPage(url, offset, limit)); }
  async readPage(input, offset, limit) {
    const requested = validatePublicURL(input).href;
    let record = this.cache.get(requested);
    if (!record || Date.now() - record.at > 300000) {
      const result = await downloadPublicResource(requested, { types: /^(text\/(html|plain)|application\/xhtml\+xml)(?:;|$)/i });
      const url = new URL(result.url);
      const charset = result.type.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]
        ?? result.bytes.subarray(0, 2048).toString('ascii').match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1] ?? 'utf-8';
      try { result.html = new TextDecoder(charset).decode(result.bytes); }
      catch { throw new Error('WEB_ENCODING_UNSUPPORTED'); }
      let extracted;
      if (/^text\/plain/i.test(result.type)) extracted = { title: '', text: result.html, links: [], images: [] };
      else {
        this.browser ??= await chromium.launch({ headless: true, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
        const context = await this.browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
        try {
          // HTML parsing only: never navigate Chromium to the untrusted site or load subresources.
          await context.route('**/*', route => route.abort());
          const page = await context.newPage();
          await page.setContent(result.html, { waitUntil: 'domcontentloaded', timeout: 15000 });
          extracted = await page.evaluate(base => {
            const title = document.title.trim().slice(0, 500);
            document.querySelectorAll('script,style,noscript,iframe,object,embed,svg,nav,footer,header,form,meta').forEach(node => node.remove());
            const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
            const links = []; const seen = new Set(); const images = [];
            for (const anchor of root.querySelectorAll('a[href]')) {
              try {
                const link = new URL(anchor.getAttribute('href'), base); link.hash = '';
                if (link.href.length > 2048 || !['http:', 'https:'].includes(link.protocol) || link.username || link.password || seen.has(link.href)) continue;
                seen.add(link.href); links.push({ title: anchor.textContent.trim().slice(0, 150), url: link.href });
                if (links.length >= 30) break;
              } catch {}
            }
            for (const image of root.querySelectorAll('img')) {
              try {
                const source = image.getAttribute('src') || image.getAttribute('data-src');
                if (!source) continue;
                const url = new URL(source, base);
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) continue;
                images.push({ url: url.href, alt: image.alt.slice(0, 150) });
                if (images.length >= 30) break;
              } catch {}
            }
            return { title, text: root.innerText.replace(/\n{3,}/g, '\n\n').trim(), links, images };
          }, url.href);
        } finally { await context.close(); }
      }
      record = { ...extracted, text: extracted.text.slice(0, MAX_TEXT), sourceTruncated: extracted.text.length > MAX_TEXT,
        url: url.href, at: Date.now(), retrievedAt: new Date().toISOString() };
      this.cache.set(requested, record);
      if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value);
    }
    const text = record.text.slice(offset, offset + limit);
    return { source: { kind: 'webpage', url: record.url, retrievedAt: record.retrievedAt }, untrusted: true,
      title: record.title, text, offset, nextOffset: offset + text.length < record.text.length ? offset + text.length : null,
      sourceTruncated: record.sourceTruncated, links: record.links, images: record.images,
      limitation: '仅公开页面原始 HTML 的正文，不运行网站脚本，不携带登录凭据；无正文可能需要动态加载或登录' };
  }
  async close() { await this.queue.idle; this.cache.clear(); await this.browser?.close(); }
}
