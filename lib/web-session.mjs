import { chromium } from 'playwright';
import { SerialQueue } from './serial-queue.mjs';
import { validatePublicURL } from './public-resource.mjs';
import { openPublicWebpage } from './web-renderer.mjs';

// One page and browser process per active turn; lifecycle cleanup interrupts work
// before awaiting its queue, so a blocked navigation cannot delay cancellation.
export class WebSession {
  constructor({ eventSocket, watch, launch = () => chromium.launch({ headless: true,
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }), open = openPublicWebpage }) {
    Object.assign(this, { eventSocket, watch, launch, open });
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
      const operationAbort = new AbortController();
      const timer = setTimeout(() => operationAbort.abort(), 30000);
      turn.operationSignal = AbortSignal.any([turn.abort.signal, operationAbort.signal]);
      const interrupt = () => { void turn.page?.close(); };
      turn.operationSignal.addEventListener('abort', interrupt, { once: true });
      try {
        const result = await operation(turn);
        await subscription.check(); subscription.assertActive();
        if (turn.abort.signal.aborted) throw new Error('WEB_TURN_EXPIRED');
        if (operationAbort.signal.aborted) throw new Error('WEB_RENDER_TIMEOUT');
        return result;
      } catch (error) {
        await turn.page?.close(); turn.page = null;
        if (operationAbort.signal.aborted) { await turn.browser?.close(); turn.browser = null; }
        throw new Error(operationAbort.signal.aborted ? 'WEB_RENDER_TIMEOUT'
          : /^WEB_[A-Z0-9_]+$/.test(error.message) ? error.message : 'WEB_RENDER_FAILED');
      } finally {
        clearTimeout(timer);
        turn.operationSignal.removeEventListener('abort', interrupt);
      }
    });
  }
  openPage(turnId, { url, wait_ms = 800 } = {}) {
    // Reject forbidden destinations before browser creation or page replacement.
    const requested = url ? validatePublicURL(url).href : null;
    return this.run(turnId, async turn => {
      if (turn.page && (!requested || requested === turn.requested || requested === turn.page.page.url())) {
        return turn.page.snapshot();
      }
      await turn.page?.close(); turn.page = null;
      if (turn.browser && !turn.browser.isConnected()) { await turn.browser.close(); turn.browser = null; }
      turn.browser ??= await this.launch();
      if (turn.operationSignal.aborted) throw new Error('WEB_TURN_EXPIRED');
      turn.page = await this.open(turn.browser, requested, { wait_ms, signal: turn.operationSignal });
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
