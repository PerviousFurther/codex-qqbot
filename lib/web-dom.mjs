import { errorCode } from './error-code.mjs';
import { randomUUID } from 'node:crypto';

export const DEFAULT_WEB_DOM_SELECTOR = 'a,button,input:not([type="hidden"]),textarea,select,[role],dialog,iframe,[aria-modal],h1,h2,h3,[class*="modal"],[class*="popup"],[class*="overlay"]';

// Fixed browser-side projection. Model arguments are data, never executable code.
function describeElements(nodes, includeHtml) {
  const forbidden = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const attrs = ['id', 'class', 'role', 'name', 'type', 'title', 'alt', 'aria-label', 'aria-modal', 'accept', 'multiple', 'placeholder', 'disabled', 'checked', 'href', 'src'];
  const attributes = node => {
    const result = {}; let characters = 0;
    for (const key of attrs) {
      const value = node.getAttribute(key);
      if (value === null) continue;
      if (key === 'href' || key === 'src') {
        try { const url = new URL(value, node.baseURI); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue; }
        catch { continue; }
      }
      const bounded = value.slice(0, 500); const size = JSON.stringify({ [key]: bounded }).length;
      if (characters + size > 6000) continue;
      result[key] = bounded; characters += size;
    }
    return result;
  };
  const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return nodes.map(node => {
    const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    const result = { tag: node.tagName.toLowerCase().slice(0, 100), attributes: attributes(node),
      text: (['INPUT', 'TEXTAREA'].includes(node.tagName.toUpperCase()) ? '' : node.innerText ?? '').slice(0, 300), visible: !!(rect.width && rect.height) && style.visibility !== 'hidden' && style.display !== 'none',
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    if (includeHtml) {
      let html = '', visited = 0, truncated = false;
      const append = value => { const remaining = 12000 - html.length; html += value.slice(0, remaining); if (value.length > remaining) truncated = true; };
      const visit = (current, depth) => {
        if (++visited > 300 || depth > 12 || html.length >= 12000) { truncated = true; return; }
        if (current.nodeType === 3) { append(escape((current.textContent ?? '').slice(0, 12000))); return; }
        if (current.nodeType !== 1 || forbidden.has(current.tagName.toUpperCase())) return;
        const tag = current.tagName.toLowerCase().slice(0, 100);
        append(`<${tag}${Object.entries(attributes(current)).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>`);
        if (!['INPUT', 'TEXTAREA'].includes(current.tagName.toUpperCase())) {
          for (const child of current.childNodes) { visit(child, depth + 1); if (truncated) break; }
        }
        append(`</${tag}>`);
      };
      visit(node, 0); result.html = html; result.htmlTruncated = truncated;
    }
    return result;
  });
}

// References are backend-held ElementHandles, not page-controlled DOM attributes.
// Each observation replaces the bounded reference set; navigation invalidates it.
export class WebDom {
  constructor(page) {
    this.page = page; this.handles = new Map(); this.generation = 0; this.pending = new Set();
    this.navigation = frame => { if (frame === page.mainFrame()) void this.clear(); };
    page.on('framenavigated', this.navigation);
  }
  clear() {
    this.generation++;
    const handles = [...this.handles.values()]; this.handles.clear();
    const cleanup = Promise.allSettled(handles.map(handle => handle.dispose()));
    this.pending.add(cleanup); void cleanup.finally(() => this.pending.delete(cleanup));
    return cleanup;
  }
  async read({ selector = DEFAULT_WEB_DOM_SELECTOR, offset = 0, limit = 40, include_html = false } = {}) {
    if (typeof include_html !== 'boolean' || typeof selector !== 'string' || !selector.length || selector.length > 500 || !Number.isInteger(offset) || offset < 0 || offset > 5000
      || !Number.isInteger(limit) || limit < 1 || limit > 80 || include_html && limit !== 1) throw new Error('WEB_DOM_QUERY_INVALID');
    await this.clear(); const generation = this.generation;
    let list; const acquired = [];
    try {
      list = await this.page.evaluateHandle(({ selector, offset, limit }) => {
        let nodes;
        try { nodes = document.querySelectorAll(selector); } catch { throw new Error('WEB_DOM_SELECTOR_INVALID'); }
        const selected = []; let matched = 0;
        for (const node of nodes) {
          if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK'].includes(node.tagName.toUpperCase())) continue;
          if (matched++ < offset) continue;
          selected.push(node);
          if (selected.length === limit + 1) break;
        }
        return selected;
      }, { selector, offset, limit });
      const properties = await list.getProperties();
      for (const [key, handle] of properties) {
        const element = handle.asElement();
        if (/^\d+$/.test(key) && element) acquired.push(element);
        else await handle.dispose();
      }
      const descriptions = await list.evaluate(describeElements, include_html);
      if (generation !== this.generation) throw new Error('WEB_DOM_STALE');
      const elements = []; let characters = 0;
      for (const [index, description] of descriptions.slice(0, limit).entries()) {
        const element_id = randomUUID(); const element = { element_id, ...description };
        let size = JSON.stringify(element).length;
        // A JSON-escaped HTML excerpt must not make even the first item exceed
        // the aggregate response budget or produce a nonadvancing nextOffset.
        while (size > 24000 && element.html?.length) {
          element.html = element.html.slice(0, Math.max(0, element.html.length - Math.ceil((size - 24000) / 2)));
          element.htmlTruncated = true; size = JSON.stringify(element).length;
        }
        if (characters + size > 24000) break;
        characters += size; this.handles.set(element_id, acquired[index]); elements.push(element);
      }
      const more = acquired.length > elements.length;
      await Promise.allSettled(acquired.slice(elements.length).map(handle => handle.dispose()));
      return { elements, offset, nextOffset: more && offset + elements.length <= 5000 ? offset + elements.length : null,
        selectionLimitReached: more && offset + elements.length > 5000, untrusted: true };

    } catch (error) {
      await Promise.allSettled(acquired.map(handle => handle.dispose()));
      if (/WEB_DOM_SELECTOR_INVALID/.test(error.message)) throw new Error('WEB_DOM_SELECTOR_INVALID');
      if (/^WEB_DOM_/.test(error.message)) throw error;
      throw new Error(errorCode(error, 'WEB_DOM_UNAVAILABLE'));
    } finally { await list?.dispose().catch(() => {}); }
  }
  async resolve(id) {
    const handle = this.handles.get(id);
    if (!handle) throw new Error('WEB_DOM_STALE');
    let connected = false;
    try { connected = await handle.evaluate(node => node.isConnected); } catch { /* Navigation/detachment invalidates references. */ }
    if (!connected || this.handles.get(id) !== handle) throw new Error('WEB_DOM_STALE');
    return handle;
  }
  async edit(id, action, unlockScroll = false) {
    if (!['remove', 'hide'].includes(action)) throw new Error('WEB_DOM_ACTION_INVALID');
    const handle = await this.resolve(id);
    const allowed = await handle.evaluate((node, { action, unlockScroll }) => {
      if (!node.isConnected || ['HTML', 'HEAD', 'BODY', 'SCRIPT', 'STYLE', 'META', 'LINK'].includes(node.tagName.toUpperCase())) return false;
      if (action === 'remove') node.remove();
      else node.style.setProperty('display', 'none', 'important');
      if (unlockScroll) for (const root of [document.documentElement, document.body]) {
        root?.style.setProperty('overflow', 'auto', 'important');
        root?.style.setProperty('overflow-y', 'auto', 'important');
      }
      return true;
    }, { action, unlockScroll });
    if (!allowed) throw new Error('WEB_DOM_EDIT_FORBIDDEN');
    await this.clear();
  }
  async close() { this.page.off('framenavigated', this.navigation); await this.clear(); await Promise.allSettled([...this.pending]); }
}
