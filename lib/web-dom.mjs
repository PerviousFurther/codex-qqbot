import { randomUUID } from 'node:crypto';

export const DEFAULT_WEB_DOM_SELECTOR = 'a,button,input:not([type="hidden"]),textarea,select,[role],dialog,iframe,[aria-modal],h1,h2,h3,[class*="modal"],[class*="popup"],[class*="overlay"]';

// Fixed browser-side projection. Model arguments are data, never executable code.
function describeElements(input, { includeHtml = false, identityOnly = false } = {}) {
  const nodes = Array.isArray(input) ? input : [input];
  const forbidden = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const attrs = ['id', 'class', 'role', 'name', 'type', 'title', 'alt', 'aria-label', 'aria-modal', 'placeholder', 'disabled', 'checked', 'href', 'src'];
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
    const text = ['INPUT', 'TEXTAREA'].includes(node.tagName.toUpperCase()) ? '' : node.innerText ?? '';
    const form = node.form ?? node.closest?.('form');
    // The digest stays backend-only and covers complete values, including text
    // beyond returned previews. Layout/classes/input values are not identity.
    const meaning = JSON.stringify([node.tagName, text.replace(/\s+/g, ' ').trim(),
      ...['role', 'name', 'type', 'title', 'alt', 'aria-label', 'aria-disabled', 'aria-checked',
        'href', 'target', 'download', 'formaction', 'formmethod', 'formtarget'].map(key => node.getAttribute(key)),
      node.href ?? null, node.type ?? null, node.disabled ?? null, node.checked ?? null,
      form?.action ?? null, form?.method ?? null, form?.target ?? null]);
    let first = 2166136261, second = 5381;
    for (let index = 0; index < meaning.length; index++) {
      first = Math.imul(first ^ meaning.charCodeAt(index), 16777619);
      second = Math.imul(second, 33) ^ meaning.charCodeAt(index);
    }
    const identity = `${meaning.length}:${first >>> 0}:${second >>> 0}`;
    const observed = { connected: node.isConnected, identity };
    if (identityOnly) return observed;
    const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    const result = { ...observed, tag: node.tagName.toLowerCase().slice(0, 100), attributes: attributes(node),
      text: text.slice(0, 300), visible: !!(rect.width && rect.height) && style.visibility !== 'hidden' && style.display !== 'none',
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
    this.page = page; this.references = new Map(); this.generation = 0; this.pending = new Set();
    this.navigation = frame => { if (frame === page.mainFrame()) void this.clear(); };
    page.on('framenavigated', this.navigation);
  }
  clear() {
    this.generation++;
    const handles = [...this.references.values()].map(entry => entry.handle); this.references.clear();
    const cleanup = Promise.allSettled(handles.map(handle => handle.dispose()));
    this.pending.add(cleanup); void cleanup.finally(() => this.pending.delete(cleanup));
    return cleanup;
  }
  async read({ selector = DEFAULT_WEB_DOM_SELECTOR, offset = 0, limit = 40, include_html = false } = {}) {
    if (this.closed) throw new Error('WEB_DOM_STALE');
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
      const descriptions = await list.evaluate(describeElements, { includeHtml: include_html });
      if (this.closed || generation !== this.generation) throw new Error('WEB_DOM_STALE');
      const elements = []; let characters = 0;
      for (const [index, { identity, connected, ...description }] of descriptions.slice(0, limit).entries()) {
        if (!connected) throw new Error('WEB_DOM_STALE');
        const element_id = randomUUID(); const element = { element_id, ...description };
        let size = JSON.stringify(element).length;
        // A JSON-escaped HTML excerpt must not make even the first item exceed
        // the aggregate response budget or produce a nonadvancing nextOffset.
        while (size > 24000 && element.html?.length) {
          element.html = element.html.slice(0, Math.max(0, element.html.length - Math.ceil((size - 24000) / 2)));
          element.htmlTruncated = true; size = JSON.stringify(element).length;
        }
        if (characters + size > 24000) break;
        characters += size; this.references.set(element_id, { handle: acquired[index], identity }); elements.push(element);
      }
      const more = acquired.length > elements.length;
      await Promise.allSettled(acquired.slice(elements.length).map(handle => handle.dispose()));
      if (this.closed || generation !== this.generation) throw new Error('WEB_DOM_STALE');
      return { elements, offset, nextOffset: more && offset + elements.length <= 5000 ? offset + elements.length : null,
        selectionLimitReached: more && offset + elements.length > 5000, untrusted: true };
    } catch (error) {
      if (generation === this.generation) await this.clear();
      await Promise.allSettled(acquired.map(handle => handle.dispose()));
      if (/WEB_DOM_SELECTOR_INVALID/.test(error.message)) throw new Error('WEB_DOM_SELECTOR_INVALID');
      if (/^WEB_DOM_/.test(error.message)) throw error;
      throw new Error('WEB_DOM_UNAVAILABLE');
    } finally { await list?.dispose().catch(() => {}); }
  }
  async resolve(id) {
    const entry = this.references.get(id);
    const handle = entry?.handle;
    if (!handle) throw new Error('WEB_DOM_STALE');
    let connected = false;
    try { connected = await handle.evaluate(node => node.isConnected); } catch { /* Navigation/detachment invalidates references. */ }
    if (!connected || this.references.get(id) !== entry) throw new Error('WEB_DOM_STALE');
    return handle;
  }
  async verifyClickTarget(id) {
    const entry = this.references.get(id);
    if (!entry) throw new Error('WEB_DOM_STALE');
    const { handle } = entry;
    let current;
    try { [current] = await handle.evaluate(describeElements, { identityOnly: true }); }
    catch { throw new Error('WEB_DOM_STALE'); }
    if (!current.connected || this.references.get(id) !== entry) throw new Error('WEB_DOM_STALE');
    if (current.identity !== entry.identity) {
      this.references.delete(id); await handle.dispose().catch(() => {});
      throw new Error('WEB_DOM_CHANGED');
    }
    return handle;
  }
  async click(id) {
    const handle = await this.verifyClickTarget(id);
    try { await handle.click({ trial: true }); }
    catch (error) {
      await this.verifyClickTarget(id);
      if (error.name === 'TimeoutError') throw new Error('WEB_DOM_NOT_ACTIONABLE');
      throw error;
    }
    // Trial may scroll/wait for overlays. Revalidate meaning after that wait,
    // then perform one normal click; never force or find a replacement node.
    await this.verifyClickTarget(id);
    await handle.click();
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
  async close() { this.closed = true; this.page.off('framenavigated', this.navigation); await this.clear(); await Promise.allSettled([...this.pending]); }
}
