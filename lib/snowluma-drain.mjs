import { randomUUID } from 'node:crypto';

// Host-only maintenance lease. Incoming traffic cancels an unsealed drain;
// continuous conversations therefore defer restart instead of losing input.
export class SnowLumaDrain {
  constructor({ busy, pause, resume, seal, now = Date.now, leaseMs = 120000 }) {
    Object.assign(this, { busy, pause, resume, seal, now, leaseMs });
    this.token = null; this.sealed = false; this.expires = 0;
  }
  async release() {
    if (!this.token) return;
    this.token = null; this.sealed = false; this.expires = 0;
    await this.resume();
  }
  async arrival() { if (this.token && !this.sealed) await this.release(); }
  async expire() { if (this.token && this.now() >= this.expires) await this.release(); }
  async command({ action, token } = {}) {
    await this.expire();
    if (action === 'begin') {
      if (this.token) return { status: 'occupied' };
      this.token = randomUUID(); this.expires = this.now() + this.leaseMs;
      this.pause();
      return { status: 'draining', token: this.token };
    }
    if (!this.token || token !== this.token) return { status: 'expired' };
    this.expires = this.now() + this.leaseMs;
    if (action === 'resume') { await this.release(); return { status: 'resumed' }; }
    if (action === 'status') return { status: this.sealed ? 'sealed' : this.busy() ? 'busy' : 'idle' };
    if (action === 'seal' && !this.sealed && !this.busy()) {
      this.sealed = true;
      await this.seal();
      return { status: 'sealed' };
    }
    return { status: 'busy' };
  }
}

export class MemoryPressure {
  constructor({ threshold = 85, sustainedMs = 300000, cooldownMs = 3600000 } = {}) {
    Object.assign(this, { threshold, sustainedMs, cooldownMs }); this.since = null; this.next = 0;
  }
  sample(percent, now) {
    if (!Number.isFinite(percent) || percent < this.threshold) { this.since = null; return false; }
    this.since ??= now;
    return now >= this.next && now - this.since >= this.sustainedMs;
  }
  attempted(now) { this.since = null; this.next = now + this.cooldownMs; }
}
