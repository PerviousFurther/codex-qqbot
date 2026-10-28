// Active work and approval waits have separate aggregate wall-clock budgets.
// Concurrent resource approvals share one wait clock rather than multiplying it.
export class WebOperationBudget {
  constructor(activeMs, signal, waitMs = 60000) {
    this.remaining = activeMs; this.waitRemaining = waitMs; this.waiters = 0;
    this.abort = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    this.arm();
  }
  arm() {
    this.started = performance.now();
    this.timer = setTimeout(() => this.abort.abort(new Error(this.waiters ? 'WEB_APPROVAL_TIMEOUT' : 'WEB_OPERATION_TIMEOUT')), this.waiters ? this.waitRemaining : this.remaining);
  }
  charge() {
    clearTimeout(this.timer);
    const elapsed = performance.now() - this.started;
    if (this.waiters) this.waitRemaining -= elapsed;
    else this.remaining -= elapsed;
  }
  async wait(operation) {
    if (this.closed) throw new Error('WEB_APPROVAL_CANCELLED');
    if (!this.waiters) { this.charge(); this.waiters++; this.arm(); }
    else this.waiters++;
    try { this.signal.throwIfAborted(); return await operation(); }
    finally {
      if (this.waiters === 1) { this.charge(); this.waiters--; if (!this.closed) this.arm(); }
      else this.waiters--;
    }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
