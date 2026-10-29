import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeId } from './policy.mjs';

// Merge the two saved feedback preferences into the remaining single switch.
// Normal group updates persist this without enabling tasks or changing reservations.
function feedbackPreference(record) {
  if (!record || !Object.hasOwn(record, 'progress')) return record;
  const { progress, ...settings } = record;
  return { ...settings, toolMonitor: record.toolMonitor === true || progress === true };
}

export class GroupAccess {
  constructor(store, configured = []) {
    this.store = store; this.configured = new Set(configured);
    this.directory = join(store.root, 'groups'); this.tail = Promise.resolve();
  }
  serial(operation) {
    const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result;
  }
  path(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('INVALID_GROUP_ID');
    return join(this.directory, `${id}.json`);
  }
  async read(id) {
    const record = feedbackPreference(await this.store.read(this.path(id), null));
    return record?.leftAt ? null : record;
  }
  membership(openid, joined, at) {
    return this.serial(async () => {
      const id = scopeId(`group:${openid}`); const path = this.path(id);
      const previous = await this.store.read(path, null);
      if (previous?.membershipAt > at || joined && previous?.membershipAt === at && previous.leftAt) return null;
      if (!joined && previous?.leftAt && previous.membershipAt === at) return previous.cleanupPending ? previous : null;
      const observedAt = new Date().toISOString();
      const record = joined ? { ...(previous?.leftAt ? { id, openid, allowed: false, listen: false, push: false, observedAt }
        : previous ?? { id, openid, allowed: this.configured.has(openid), listen: false, push: false, observedAt }), membershipAt: at }
        : { id, openid, allowed: false, listen: false, push: false, observedAt,
          membershipAt: at, leftAt: observedAt, cleanupPending: true };
      await this.store.write(path, record); return record;
    });
  }
  async departed() { return (await this.records(true)).filter(record => record.leftAt); }
  observe(openid, metadata = {}, assertCurrent = () => {}) {
    return this.serial(async () => {
      assertCurrent();
      const id = scopeId(`group:${openid}`); const path = this.path(id);
      let record = feedbackPreference(await this.store.read(path, null));
      const publish = !record || typeof metadata.name === 'string' && metadata.name.slice(0, 200) !== record.name;
      if (!record) {
        record = { id, openid, allowed: this.configured.has(openid), listen: false, push: false,
          observedAt: new Date().toISOString() };
      }
      if (!record.leftAt && publish) {
        if (typeof metadata.name === 'string') record.name = metadata.name.slice(0, 200);
        assertCurrent();
        await this.store.write(path, record);
      }
      return record;
    });
  }
  async records(includeDeparted = false) {
    await this.tail;
    let names;
    try { names = await readdir(this.directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    return (await Promise.all(names.filter(name => /^[a-f0-9]{32}\.json$/.test(name))
      .map(name => this.store.read(this.path(name.slice(0, -5)), null))))
      .map(feedbackPreference).filter(record => record && (includeDeparted || !record.leftAt)).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }
  update(id, change) {
    return this.serial(async () => {
      const record = feedbackPreference(await this.store.read(this.path(id), null));
      if (!record || record.leftAt) throw new Error('GROUP_NOT_OBSERVED');
      await change(record); await this.store.write(this.path(id), record); return record;
    });
  }
}
