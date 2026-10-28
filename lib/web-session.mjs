import { chromium } from 'playwright';
import { SerialQueue } from './serial-queue.mjs';
import { WebOperationBudget } from './web-operation-budget.mjs';
import { authorizePublicURL, validatePublicURL } from './public-resource.mjs';
import { openPublicWebpage } from './web-renderer.mjs';

// One page and browser process per active turn; lifecycle cleanup interrupts work
// before awaiting its queue, so a blocked navigation cannot delay cancellation.
export class WebSession {
  constructor({ eventSocket, watch, requestDomain, launch = () => chromium.launch({ headless: true,
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }), open = openPublicWebpage }) {
    Object.assign(this, { eventSocket, watch, requestDomain, launch, open });
    this.queue = new SerialQueue();
  }
  async bind(turnId) {
    if (this.closed || !turnId || !this.eventSocket) throw new Error('WEB_TURN_REQUIRED');
    if (this.turn && this.turn.id !== turnId) throw new Error('WEB_TURN_MISMATCH');
    if (!this.turn) {
      const turn = { id: turnId, abort: new AbortController() };
      this.turn = turn;
      turn.subscription = this.watch(this.eventSocket, turnId, () => this.cleanup(turn));
    }
    const turn = this.turn;
    let subscription;
    try { subscription = await turn.subscription; }
    catch (error) {
      turn.abort.abort();
      if (this.turn === turn) this.turn = null;
      throw error;
    }
    await subscription.check(); subscription.assertActive();
    if (turn.abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
    return { turn, subscription };
  }
  run(turnId, operation) {
    return this.queue.run(async () => {
      const { turn, subscription } = await this.bind(turnId);
      const budget = new WebOperationBudget(30000, turn.abort.signal);
      turn.operationSignal = budget.signal;
      turn.requestDomain = this.requestDomain && ((host, signal) => budget.wait(() => this.requestDomain(host, turnId, signal)));
      const interrupt = () => { void turn.page?.close(); };
      turn.operationSignal.addEventListener('abort', interrupt, { once: true });
      try {
        const result = await operation(turn);
        await subscription.check(); subscription.assertActive();
        if (turn.abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
        if (budget.abort.signal.aborted) throw new Error('WEB_RENDER_TIMEOUT');
        return result;
      } catch (error) {
        await turn.page?.close(); turn.page = null;
        if (budget.abort.signal.aborted) { await turn.browser?.close(); turn.browser = null; }
        throw Object.assign(new Error(budget.abort.signal.aborted ? (budget.signal.reason?.message === 'WEB_APPROVAL_TIMEOUT' ? 'WEB_APPROVAL_TIMEOUT' : 'WEB_RENDER_TIMEOUT')
          : /^WEB_[A-Z0-9_]+$/.test(error.message) ? error.message : 'WEB_RENDER_FAILED'),
          error.message === 'WEB_DOMAIN_NOT_ALLOWED' && error.webDomain ? { webDomain: error.webDomain } : {});
      } finally {
        budget.close();
        turn.operationSignal.removeEventListener('abort', interrupt);
      }
    });
  }
  openPage(turnId, { url, wait_ms = 800 } = {}) {
    // Reject forbidden destinations before browser creation or page replacement.
    // Keep synchronous rejection for malformed/adult URLs; unknown hosts wait inside the turn.
    if (url) {
      try { validatePublicURL(url); }
      catch (error) { if (error.message !== 'WEB_DOMAIN_NOT_ALLOWED' || !this.requestDomain) throw error; }
    }
    return this.run(turnId, async turn => {
      const requested = url ? (await authorizePublicURL(url, { requestDomain: turn.requestDomain, signal: turn.operationSignal })).href : null;
      if (turn.page && (!requested || requested === turn.requested || requested === turn.page.page.url())) {
        return turn.page.snapshot();
      }
      await turn.page?.close(); turn.page = null;
      if (turn.browser && !turn.browser.isConnected()) { await turn.browser.close(); turn.browser = null; }
      turn.browser ??= await this.launch();
      if (turn.operationSignal.aborted) throw new Error('WEB_TURN_EXPIRED');
      turn.page = await this.open(turn.browser, requested, { wait_ms, signal: turn.operationSignal, requestDomain: (host, signal) => turn.requestDomain?.(host, signal) });
      turn.requested = requested;
      return turn.page.snapshot();
    });
  }
  snapshot(turnId, options = {}) {
    return this.run(turnId, async turn => {
      if (!turn.page) throw new Error('WEB_PAGE_NOT_OPEN');
      return turn.page.snapshot(options);
    });
  }
  interact(turnId, options) {
    return this.run(turnId, async turn => {
      if (!turn.page) throw new Error('WEB_PAGE_NOT_OPEN');
      await turn.page.interact(options);
      return turn.page.snapshot();
    });
  }
  readDom(turnId, options) {
    return this.run(turnId, async turn => {
      if (!turn.page) throw new Error('WEB_PAGE_NOT_OPEN');
      return turn.page.readDom(options);
    });
  }
  editDom(turnId, { element_id, action, unlock_scroll = false }) {
    return this.run(turnId, async turn => {
      if (!turn.page) throw new Error('WEB_PAGE_NOT_OPEN');
      await turn.page.editDom(element_id, action, unlock_scroll);
      return turn.page.snapshot();
    });
  }
  closePage(turnId) {
    return this.run(turnId, async turn => {
      await turn.page?.close(); turn.page = null;
      await turn.browser?.close(); turn.browser = null;
      return { closed: true };
    });
  }
  cleanup(turn) {
    if (turn.cleaning) return turn.cleaning;
    turn.abort.abort();
    turn.cleaning = (async () => {
      await turn.page?.close();
      // An in-flight launch/open may still be assigning resources.
      await this.queue.idle;
      await turn.page?.close();
      await turn.browser?.close();
      if (this.turn === turn) this.turn = null;
    })();
    return turn.cleaning;
  }
  async close() {
    this.closed = true;
    const turn = this.turn;
    if (turn) {
      await this.cleanup(turn);
      await (await turn.subscription.catch(() => null))?.close();
    }
  }
}
