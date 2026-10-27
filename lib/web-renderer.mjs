import { MAX_IMAGE_BYTES } from './image-policy.mjs';
import { downloadPublicResource, validatePublicURL } from './public-resource.mjs';

const TYPES = /^(?:text\/[a-z0-9.+-]+|image\/(?:png|jpeg|gif|webp|svg\+xml|avif|x-icon)|font\/[a-z0-9.+-]+|application\/(?:xhtml\+xml|javascript|x-javascript|json|wasm|font-woff|vnd\.ms-fontobject|octet-stream))(?:;|$)/i;
const MAX_RENDER_BYTES = 32 * 1024 * 1024;
const DOCUMENT = /^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i;

// Every browser HTTP request is fulfilled by the same DNS-pinned public downloader.
// Chromium never connects directly to website origins or inherits Bilibili credentials.
export async function renderPublicWebpage(browser, input, { scroll_y = 0, wait_ms = 800 } = {}) {
  const requested = validatePublicURL(input).href;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce',
    // No browser-side fallback sockets: intercepted resources are fulfilled below.
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' } });
  const abort = new AbortController();
  const deadline = setTimeout(() => { abort.abort(); void context.close().catch(() => {}); }, 30000);
  let requests = 0; let transferred = 0; let blocked = 0; let mainError; let mainLoaded = false; let resourceLimit = false;
  const pending = new Set();
  try {
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']) {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(20000);
    context.on('page', other => { if (other !== page) void other.close().catch(() => {}); });
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    const load = async (url, main, image = false) => {
      if (abort.signal.aborted || ++requests > 80 || transferred >= MAX_RENDER_BYTES) throw new Error('WEB_RENDER_RESOURCE_LIMIT');
      return downloadPublicResource(url, {
        types: main ? DOCUMENT : TYPES, maxBytes: Math.min(image ? MAX_IMAGE_BYTES : 4 * 1024 * 1024, MAX_RENDER_BYTES - transferred), signal: abort.signal,
        onBytes: size => {
          transferred += size;
          if (transferred > MAX_RENDER_BYTES) { resourceLimit = true; abort.abort(); throw new Error('WEB_RENDER_RESOURCE_LIMIT'); }
        },
      });
    };
    // Resolve document redirects in the checked downloader before navigation.
    // Playwright does not route redirected browser requests a second time.
    const document = await load(requested, true);
    const finalURL = validatePublicURL(document.url).href;
    const handle = async route => {
      const request = route.request();
      const main = request.isNavigationRequest() && request.frame() === page.mainFrame();
      try {
        if (request.method() !== 'GET' || !['document', 'stylesheet', 'script', 'image', 'font', 'xhr', 'fetch'].includes(request.resourceType())
          || request.isNavigationRequest() && !main || main && mainLoaded) throw new Error('WEB_RENDER_REQUEST_BLOCKED');
        if (main && validatePublicURL(request.url()).href !== finalURL) throw new Error('WEB_RENDER_REQUEST_BLOCKED');
        const result = main ? document : await load(request.url(), false, request.resourceType() === 'image');
        if (abort.signal.aborted || transferred > MAX_RENDER_BYTES) throw new Error('WEB_RENDER_RESOURCE_LIMIT');
        // Never synthesize a browser redirect: all HTTP hops were checked above.
        // Resource bytes are served at the requested URL; redirected stylesheets
        // may have relative assets that the bounded renderer cannot reconstruct.
        await route.fulfill({ status: result.status, contentType: result.type, headers: result.headers, body: result.bytes });
        if (main) mainLoaded = true;
      } catch (error) {
        blocked++;
        if (main && !mainLoaded) mainError = /^WEB_[A-Z0-9_]+$/.test(error.message) ? error.message : 'WEB_RENDER_FAILED';
        await route.abort().catch(() => {});
      }
    };
    await context.route('**/*', route => {
      const task = handle(route); pending.add(task);
      return task.finally(() => pending.delete(task));
    });
    const response = await page.goto(finalURL, { waitUntil: 'domcontentloaded' });
    if (!response?.ok() || mainError || !mainLoaded) throw new Error(mainError ?? 'WEB_RENDER_PAGE_UNAVAILABLE');
    await page.waitForTimeout(wait_ms);
    await page.evaluate(y => window.scrollTo(0, y), scroll_y);
    // Allow the scroll/layout to reach the compositor without waiting for network idle.
    await page.waitForTimeout(150);
    if (resourceLimit) throw new Error('WEB_RENDER_RESOURCE_LIMIT');
    validatePublicURL(page.url());
    const details = await page.evaluate(() => {
      const links = []; const images = [];
      const url = value => { try { const parsed = new URL(value, location.href); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.href.length <= 2048 ? parsed.href : null; } catch { return null; } };
      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = url(anchor.href);
        if (href) links.push({ title: anchor.textContent.trim().slice(0, 150), url: href });
        if (links.length === 30) break;
      }
      for (const image of document.images) {
        const src = url(image.currentSrc || image.src);
        if (src) images.push({ url: src, alt: image.alt.slice(0, 150), width: image.naturalWidth, height: image.naturalHeight });
        if (images.length === 30) break;
      }
      const body = document.body?.innerText ?? '';
      return { title: document.title.slice(0, 500), text: body.slice(0, 12000), textTruncated: body.length > 12000,
        scroll_y: window.scrollY, page_height: Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight), links, images };
    });
    const image = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, timeout: 10000 });
    if (image.length > MAX_IMAGE_BYTES) throw new Error('WEB_SCREENSHOT_TOO_LARGE');
    return { ...details, image, url: page.url(), viewport: { width: 1280, height: 800 }, blocked_resources: blocked,
      limitation: 'Public isolated browser viewport; scripts may run but only bounded public GET resources are loaded. No login, forms, clicks, audio/video decoding or arbitrary execution. Blocked resources, lazy loading or access gates may leave the page incomplete.' };
  } catch (error) {
    throw new Error(resourceLimit ? 'WEB_RENDER_RESOURCE_LIMIT' : mainError ?? (abort.signal.aborted ? 'WEB_RENDER_TIMEOUT'
      : /^WEB_[A-Z0-9_]+$/.test(error.message) ? error.message : error.name === 'TimeoutError' ? 'WEB_RENDER_TIMEOUT' : 'WEB_RENDER_FAILED'));
  } finally {
    clearTimeout(deadline); abort.abort();
    await context.close().catch(() => {});
    await Promise.allSettled(pending);
  }
}
