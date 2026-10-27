import { imageLimitDetails } from './image-policy.mjs';
import { downloadQQImage } from './qq-images.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { scopeId } from './policy.mjs';
import { contentCodecs } from './content-codecs.mjs';

export function messageImageAttachments(message) {
  return (Array.isArray(message.attachments) ? message.attachments : []).filter(item => {
    if (!item || typeof item.url !== 'string') return false;
    const type = String(item.content_type ?? '').toLowerCase();
    if (/^(?:audio|video)\//.test(type) || ['voice', 'audio', 'video', 'file'].includes(type)) return false;
    return type === 'image' || /^image\//.test(type) || /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(item.filename || item.url)
      || Number(item.width) > 0 && Number(item.height) > 0;
  }).slice(0, 6);
}

// Only URLs supplied by received QQ events are indexed. The model receives opaque IDs, never download tokens.
export class MessageImages {
  constructor(store) { this.store = store; this.connections = new Map(); }
  database(scope) {
    if (!/^(?:group|c2c):.+/.test(scope)) throw new Error('IMAGE_SCOPE_REQUIRED');
    if (!this.connections.has(scope)) this.connections.set(scope, this.open(scope).catch(error => { this.connections.delete(scope); throw error; }));
    return this.connections.get(scope);
  }
  async open(scope) {
    const dir = join(this.store.root, 'message-images'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(dir, `${scopeId(scope)}.sqlite`), { timeout: 2500, allowExtension: false });
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576;
        CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY,message_id TEXT NOT NULL,sender_id TEXT NOT NULL,
          received INTEGER NOT NULL,url TEXT NOT NULL,historical INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS images_received ON images(received);`);
      return db;
    } catch (error) { db.close(); throw error; }
  }
  async capture(scope, message, historical = false) {
    const attachments = messageImageAttachments(message);
    if (!attachments.length) return [];
    const db = await this.database(scope); const refs = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [index, item] of attachments.entries()) {
        const id = createHash('sha256').update(`${scope}\0${message.messageId}\0${index}`).digest('hex').slice(0, 32);
        db.prepare('INSERT OR IGNORE INTO images(id,message_id,sender_id,received,url,historical) VALUES(?,?,?,?,?,?)')
          .run(id, message.messageId, message.senderId, Date.now(), item.url.slice(0, 8192), Number(historical));
        refs.push({ id, source: message.kind === 'group' ? 'qq_group_image' : 'qq_private_image', index: index + 1 });
      }
      db.prepare('DELETE FROM images WHERE received<?').run(Date.now() - 7 * 86400000);
      db.exec('DELETE FROM images WHERE id NOT IN (SELECT id FROM images ORDER BY received DESC,id DESC LIMIT 512)');
      db.exec('COMMIT'); return refs;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async remove(scope, id) { (await this.database(scope)).prepare('DELETE FROM images WHERE id=?').run(id); }
  async clear(scope) { const db = await this.database(scope); db.exec('DELETE FROM images; PRAGMA wal_checkpoint(TRUNCATE)'); }
  async load(scope, id, assertAccess, options = {}) {
    await assertAccess();
    const db = await this.database(scope);
    const row = db.prepare('SELECT * FROM images WHERE id=? AND received>=?').get(id, Date.now() - 7 * 86400000);
    if (!row) throw new Error('IMAGE_NOT_RETAINED');
    const recheck = async () => {
      await assertAccess(row);
      if (!db.prepare('SELECT id FROM images WHERE id=? AND received>=?').get(id, Date.now() - 7 * 86400000)) throw new Error('IMAGE_NOT_RETAINED');
    };
    await recheck();
    const image = await downloadQQImage(row.url, options);
    await recheck();
    return { ...image, assertAccess: recheck, source: {
      kind: scope.startsWith('group:') ? 'qq_group_image' : 'qq_private_image',
      imageId: id, messageId: row.message_id, senderOpenid: row.sender_id, receivedAt: new Date(row.received).toISOString(),
      historical: !!row.historical,
      ...(row.message_id.startsWith('element:') ? { embedded: true, identityVerified: false } : {}),
    } };
  }
  async read(scope, ids, assertAccess) {
    await assertAccess(); const result = []; const returned = [];
    for (const id of ids) {
      try {
        const image = await this.load(scope, id, assertAccess);
        result.push(contentCodecs.value('image', { bytes: image.bytes, mimeType: image.mimeType, source: image.source }));
        returned.push(image.assertAccess);
      } catch (error) {
        await assertAccess();
        if (error.message === 'GROUP_MESSAGES_DISABLED') throw error;
        result.push(contentCodecs.value('json', { imageId: id, error: /^[A-Z_]+$/.test(error.message) ? error.message : 'IMAGE_READ_FAILED', ...imageLimitDetails(error) }));
      }
    }
    for (const recheck of returned) await recheck();
    await assertAccess(); return result;
  }
  async close() { for (const db of this.connections.values()) (await db).close(); this.connections.clear(); }
}
