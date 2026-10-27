import { join } from 'node:path';
import { scopeId, redactCredentials } from './policy.mjs';
import { SerialQueue } from './serial-queue.mjs';

// Recipient metadata only, learned from authorized direct QQ events, never chat bodies.
export class ReplyContacts {
  constructor(store) { this.store = store; this.path = join(store.root, 'reply-contacts.json'); this.queue = new SerialQueue(); }
  async records() {
    const data = await this.store.read(this.path, {});
    return Object.entries(data).filter(([id, value]) => typeof value?.openid === 'string'
      && id === scopeId(`c2c:${value.openid}`)).map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.seenAt - a.seenAt).slice(0, 100);
  }
  async get(scope) { return (await this.records()).find(record => record.id === scopeId(scope)); }
  update(change) {
    return this.queue.run(async () => {
      const data = await this.store.read(this.path, {});
      change(data);
      const rows = Object.entries(data).sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, 100);
      await this.store.write(this.path, Object.fromEntries(rows));
    });
  }
  observe(message) {
    if (message.kind !== 'c2c' || message.senderIsBot || !message.messageId
      || typeof message.senderId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(message.senderId)) throw new Error('PRIVATE_CONTACT_INVALID');
    return this.update(data => {
      const id = scopeId(`c2c:${message.senderId}`);
      const name = redactCredentials(String(message.senderName ?? '')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80);
      data[id] = { openid: message.senderId, name: name || data[id]?.name || '', seenAt: Date.now(), blocked: false };
    });
  }
  block(scope) { return this.update(data => { const record = data[scopeId(scope)]; if (record) record.blocked = true; }); }
  remove(scope) { return this.update(data => { delete data[scopeId(scope)]; }); }
}
