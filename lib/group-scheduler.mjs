import { groupDecision } from './group-policy.mjs';

// This module only decides when to run work. It does not call models or send QQ messages.
export class GroupScheduler {
  constructor({ status, process, busy, event, loadGroup }) {
    Object.assign(this, { status, process, busy, event, loadGroup });
    this.entries = new Map(); this.closed = false;
  }
  async configure(groups) {
    const retained = new Set(groups.map(group => group.id));
    for (const [id, entry] of this.entries) if (!retained.has(id)) { clearTimeout(entry.timer); this.entries.delete(id); }
    for (const group of groups) {
      let entry = this.entries.get(group.id);
      if (!entry) { entry = { group, tail: Promise.resolve(), timer: null, running: false }; this.entries.set(group.id, entry); }
      entry.group = group;
      await this.notify(group.id);
    }
  }
  observe(group) {
    let entry = this.entries.get(group.id);
    if (!entry) { entry = { group, tail: Promise.resolve(), timer: null, running: false }; this.entries.set(group.id, entry); }
    entry.group = group; return this.notify(group.id);
  }
  async resume() { await Promise.all([...this.entries.keys()].map(id => this.notify(id))); }
  notify(id) {
    const entry = this.entries.get(id);
    if (!entry || this.closed) return;
    const task = entry.tail.then(() => this.arm(entry));
    entry.tail = task.catch(error => this.event(entry.group, 'scheduler_failed', error));
    return entry.tail;
  }
  async arm(entry) {
    if (this.closed || entry.running || this.entries.get(entry.group.id) !== entry) return;
    if (!entry.group.allowed || !(entry.group.listen || entry.group.push) || entry.group.taskBlocked) {
      clearTimeout(entry.timer); entry.timer = null;
      entry.decision = { kind: 'disabled', due: null }; return;
    }
    if (this.busy()) { clearTimeout(entry.timer); entry.timer = null; return; }
    const status = await this.status(entry.group);
    if (this.closed || entry.running || this.entries.get(entry.group.id) !== entry) return;
    const decision = groupDecision(entry.group, status);
    entry.decision = decision;
    if (decision.due === null) { clearTimeout(entry.timer); entry.timer = null; return; }
    const delay = Math.max(25, decision.due - Date.now());
    const dueAt = Date.now() + delay;
    if (entry.timer && entry.dueAt <= dueAt) return;
    clearTimeout(entry.timer); entry.dueAt = dueAt;
    entry.timer = setTimeout(() => this.fire(entry).catch(error => this.event(entry.group, 'scheduler_failed', error)), Math.min(delay, 2147483647));
    entry.timer.unref();
  }
  async fire(entry) {
    entry.timer = null;
    if (this.closed || entry.running || this.entries.get(entry.group.id) !== entry) return;
    if (this.busy()) return this.notify(entry.group.id);
    const current = await this.loadGroup(entry.group.id);
    if (!current || this.closed || this.entries.get(entry.group.id) !== entry) return;
    entry.group = current;
    const status = await this.status(entry.group);
    if (this.closed || this.entries.get(entry.group.id) !== entry) return;
    const decision = groupDecision(entry.group, status);
    if (decision.due === null || decision.due > Date.now()) return this.notify(entry.group.id);
    entry.running = true;
    try { const result = await this.process(entry.group, { ...decision, status }); if (result?.group) entry.group = result.group; }
    catch (error) { this.event(entry.group, 'scheduler_failed', error); }
    finally { entry.running = false; await this.notify(entry.group.id); }
  }
  close() { this.closed = true; for (const entry of this.entries.values()) clearTimeout(entry.timer); }
}
