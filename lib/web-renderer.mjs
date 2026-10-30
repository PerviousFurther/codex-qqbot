import { errorCode } from './error-code.mjs';
import { WebPlayers } from './web-players.mjs';
import { WebUploads } from './web-uploads.mjs';
import { WebDom } from './web-dom.mjs';
import { SerialQueue } from './serial-queue.mjs';
import { MAX_IMAGE_BYTES } from './image-policy.mjs';
import { downloadPublicResource, authorizePublicURL, validatePublicURL } from './public-resource.mjs';

const TYPES = /^(?:text\/[a-z0-9.+-]+|(?:video|audio)\/[a-z0-9.+-]+|image\/(?:png|jpeg|gif|webp|svg\+xml|avif|x-icon)|font\/[a-z0-9.+-]+|application\/(?:xhtml\+xml|javascript|x-javascript|json|wasm|font-woff|vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|vnd\.ms-fontobject|octet-stream))(?:;|$)/i;
const DOCUMENT = /^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i;

// Every browser HTTP request is fulfilled by the same DNS-pinned public downloader.
// Chromium never connects directly to website origins or inherits host-browser credentials.
export async function openPublicWebpage(browser, input, { wait_ms = 800, signal, requestDomain, cookies, loadCookies, saveCookies } = {}) {
  const requested = input ? (await authorizePublicURL(input, { requestDomain, signal })).href : null;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce',
    // No browser-side fallback sockets: intercepted resources are fulfilled below.
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    ...(cookies ? { storageState: { cookies, origins: [] } } : {}) });
  const abort = new AbortController();
  const pending = new Set(); const navigations = new Set();
  let cleaning, dom, players, uploads;
  const cookieWrites = new SerialQueue();
  let previousCookies = cookies ?? [];
  const persist = async () => {
    if (saveCookies) {
      try {
        const next = await context.cookies();
        await saveCookies(next, previousCookies);
        previousCookies = next;
      }
      catch { throw new Error('WEB_COOKIE_SAVE_FAILED'); }
    }
  };
  const persistCookies = () => cookieWrites.run(persist);
  const syncCookies = () => cookieWrites.run(async () => {
    if (!loadCookies) return;
    await persist();
    const latest = await loadCookies();
    await context.clearCookies();
    previousCookies = []; // A failed restore must not publish accidental deletions.
    await context.addCookies(latest);
    previousCookies = latest;
  });
  const close = () => cleaning ??= (async () => {
    abort.abort();
    try { await persistCookies(); }
    finally {
      await context.close().catch(() => {});
      await dom?.close();
      await players?.close(); uploads?.close();
      await Promise.allSettled([...pending, ...navigations]);
    }
  })();
  const onAbort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let requests = 0; let transferred = 0; let blocked = 0; let mainError; let deniedHost;
  let ready = false;
  try {
    if (signal?.aborted) throw new Error('WEB_TURN_EXPIRED');
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']) {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: false });
      }
    });
    const page = await context.newPage();
    dom = new WebDom(page); players = new WebPlayers(page); uploads = new WebUploads(page, dom);
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(0);
    context.on('page', other => { if (other !== page) void other.close().catch(() => {}); });
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    const load = async (url, main, image = false, browserRequest = { method: 'GET', headers: {} }) => {
      if (abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
      requests++;
      return downloadPublicResource(url, {
        requestDomain, browserRequest, types: main ? DOCUMENT : TYPES, maxBytes: image ? MAX_IMAGE_BYTES : browserRequest.media ? 16 * 1024 * 1024 : 4 * 1024 * 1024, signal: abort.signal,
        onBytes: size => { transferred += size; },
      });
    };
    // Resolve document redirects in the checked downloader before navigation.
    // Playwright does not route redirected browser requests a second time.
    const initialCookies = requested && cookies ? await context.cookies(requested) : [];
    const document = requested ? await load(requested, true, false, { method: 'GET', headers: initialCookies.length
      ? { cookie: initialCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {} }) : null;
    const finalURL = document ? validatePublicURL(document.url).href : 'about:blank';
    const seeded = new Map();
    if (document) seeded.set(page.mainFrame(), document);
    const handle = async route => {
      const request = route.request();
      const navigation = request.isNavigationRequest();
      let frame = null;
      try {
        frame = navigation ? request.frame() : null;
        if (request.frame().page() !== page) throw new Error('WEB_RENDER_REQUEST_BLOCKED');
        if (!['document', 'stylesheet', 'script', 'image', 'font', 'media', 'xhr', 'fetch', 'other'].includes(request.resourceType())) throw new Error('WEB_RENDER_REQUEST_BLOCKED');
        const url = (await authorizePublicURL(request.url(), { requestDomain, signal: abort.signal })).href;
        const cached = seeded.get(frame);
        const result = cached && url === cached.url ? (seeded.delete(frame), cached)
          : await load(url, navigation, request.resourceType() === 'image', {
            method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(),
            ...await uploads.request(request.postDataBuffer()), media: request.resourceType() === 'media',
          });
        if (abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
        // Never emit a browser-side HTTP redirect: Chromium can follow it outside
        // routing. Transfer already-acquired document bytes to a checked final-URL
        // navigation instead, without repeating POSTs or other submitted requests.
        if (navigation && url !== result.url) {
          seeded.set(frame, result);
          const committed = page.waitForEvent('framenavigated', { predicate: current => current === frame });
          void committed.catch(() => {});
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Loading</title>' });
          const task = (async () => {
            await committed;
            await frame.evaluate(url => location.replace(url), result.url);
            await frame.waitForURL(result.url, { waitUntil: 'domcontentloaded' });
          })().catch(error => {
            if (!abort.signal.aborted && frame === page.mainFrame()) mainError = errorCode(error, 'WEB_NAVIGATION_FAILED');
          });
          navigations.add(task); void task.finally(() => navigations.delete(task));
          return;
        }
        const headers = { ...result.headers };
        // A redirected subresource is served at its original browser URL; never
        // attach the final destination's cookies to that different URL.
        if (url !== result.url) delete headers['set-cookie'];
        await route.fulfill({ status: result.status, contentType: result.type, headers, body: result.bytes });
      } catch (error) {
        blocked++;
        if (error.message === 'WEB_DOMAIN_NOT_ALLOWED' && error.webDomain) {
          if (navigation && frame === page.mainFrame()) deniedHost = error.webDomain;
        }
        if (navigation && frame === page.mainFrame()) mainError = errorCode(error, 'WEB_RENDER_FAILED');
        await route.abort().catch(() => {});
      }
    };
    await context.route('**/*', route => {
      const task = handle(route); pending.add(task);
      return task.finally(() => pending.delete(task));
    });
    if (requested) {
      const response = await page.goto(finalURL, { waitUntil: 'domcontentloaded' });
      if (!response || mainError) throw new Error(mainError ?? 'WEB_RENDER_PAGE_UNAVAILABLE');
    }
    await page.waitForTimeout(wait_ms);
    if (page.url() !== 'about:blank') validatePublicURL(page.url());
    ready = true;
    return {
      page,
      persistCookies, syncCookies,
      listMedia: () => players.list(),
      readMedia: options => players.read(options),
      subtitles: options => players.subtitles(options),
      upload: async (elementId, file, wait_ms) => {
        mainError = null; deniedHost = undefined;
        const result = await uploads.select(elementId, file, wait_ms);
        while (pending.size || navigations.size) await Promise.allSettled([...pending, ...navigations]);
        if (mainError) throw new Error(mainError);
        return result;
      },
      readDom: options => dom.read(options),
      editDom: (id, action, unlockScroll) => dom.edit(id, action, unlockScroll),
      interact: async ({ action, x, y, element_id, text, key, wait_ms = 300 }) => {
        if (abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
        mainError = null; deniedHost = undefined;
        if (action === 'click') {
          if (element_id) {
            if (x !== undefined || y !== undefined) throw new Error('WEB_CLICK_TARGET_INVALID');
            await (await dom.resolve(element_id)).click();
          } else {
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('WEB_CLICK_TARGET_INVALID');
            await page.mouse.click(x, y);
          }
        }
        else if (action === 'type') await page.keyboard.insertText(text);
        else if (action === 'press') await page.keyboard.press(key);
        else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' }).catch(error => {
          if (!navigations.size) throw error;
        });
        else throw new Error('WEB_ACTION_INVALID');
        // Give input-triggered navigation a compositor/event-loop opportunity
        // before draining routed requests, even when no extra wait is requested.
        await page.waitForTimeout(Math.max(150, wait_ms));
        while (pending.size || navigations.size) await Promise.allSettled([...pending, ...navigations]);
        if (mainError) throw Object.assign(new Error(mainError), deniedHost ? { webDomain: deniedHost } : {});
      },
      snapshot: async ({ scroll_y, clip } = {}) => {
        if (abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
        while (pending.size || navigations.size) await Promise.allSettled([...pending, ...navigations]);
        if (mainError) throw new Error(mainError);
        if (page.url() !== 'about:blank') validatePublicURL(page.url());
        if (scroll_y !== undefined) {
          await page.evaluate(y => window.scrollTo(0, y), scroll_y);
          await page.waitForTimeout(150);
          while (pending.size || navigations.size) await Promise.allSettled([...pending, ...navigations]);
          if (mainError) throw new Error(mainError);
        }
        if (clip && (clip.x + clip.width > 1280 || clip.y + clip.height > 800)) throw new Error('WEB_CLIP_OUT_OF_BOUNDS');
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
        const image = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, timeout: 10000,
          ...(clip ? { clip } : {}) });
        if (image.length > MAX_IMAGE_BYTES) throw new Error('WEB_SCREENSHOT_TOO_LARGE');
        if (abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
        if (page.url() !== 'about:blank') validatePublicURL(page.url());
        return { ...details, dom: await dom.read(), image, url: page.url(), viewport: { width: 1280, height: 800 }, clip: clip ?? null,
          blocked_resources: blocked, requests, transferred_bytes: transferred,
          limitation: 'Turn-owned browser page with shared bot-account cookies; no inherited host-browser credentials. Text is a bounded document prefix, not viewport-only text. Screenshots show the viewport or its requested crop. Checked public HTTP requests support interaction and forms. HTML video/audio use checked bounded resources; DRM and unsupported codecs remain unavailable. No extra tabs. Local/session storage is not persisted. Redirect response cookies may be incomplete; interaction is not proof of login or action success. Blocked resources and lazy loading may leave content incomplete.' };
      },
      close: async () => { signal?.removeEventListener('abort', onAbort); await close(); },
    };
  } catch (error) {
    throw Object.assign(new Error(mainError ?? (abort.signal.aborted ? 'WEB_RENDER_TIMEOUT'
      : errorCode(error, error.name === 'TimeoutError' ? 'WEB_RENDER_TIMEOUT' : 'WEB_RENDER_FAILED'))), (deniedHost ?? error.webDomain) ? { webDomain: deniedHost ?? error.webDomain } : {});
  } finally {
    if (!ready) { signal?.removeEventListener('abort', onAbort); await close(); }
  }
}
