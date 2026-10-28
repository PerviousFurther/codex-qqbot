import { MAX_IMAGE_BYTES, imageType } from './image-policy.mjs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { scopeId, redactCredentials } from './policy.mjs';
import { assertMessageAccess } from './message-access.mjs';

export const SAVED_IMAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, created INTEGER NOT NULL,
    label TEXT NOT NULL, source TEXT NOT NULL, shareable INTEGER NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS images_scope ON images(scope, created);
`;
const TTL = 7 * 86400000;
const MAX_IMAGE = MAX_IMAGE_BYTES;
const clean = value => redactCredentials(String(value ?? '')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
const publicSource = source => ['public_image', 'webpage_screenshot'].includes(source.kind);
function imageMetadata(row) {
  const source = JSON.parse(row.source);
  return { asset_id: row.id, label: row.label, source, mimeType: row.mime,
    expiresAt: new Date(row.created + TTL).toISOString(), shareable: !!row.shareable && publicSource(source) };
}

// Shared transactional, bounded storage. Only opaque scope-local IDs leave this module.
// Short-lived connections avoid stale handles across MCP/main-process maintenance.
export class SavedImages {
  constructor(store) { this.store = store; }
  async access(scope, action, { cleanup = false } = {}) {
    if (!cleanup) await assertMessageAccess(scope, this.store);
    const dir = join(this.store.root, 'saved-images');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(dir, 'images.sqlite'), { timeout: 2500, allowExtension: false });
    try {
      db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      db.exec(SAVED_IMAGE_SCHEMA);
      db.prepare('DELETE FROM images WHERE created<?').run(Date.now() - TTL);
      const result = action(db, scopeId(scope));
      if (!cleanup) await assertMessageAccess(scope, this.store);
      return result;
    } finally { db.close(); }
  }
  async save(scope, bytes, { label = '', source, shareable = false }) {
    const mime = imageType(bytes);
    if (!bytes.length || bytes.length > MAX_IMAGE) throw new Error('SAVED_IMAGE_TOO_LARGE');
    if (!['public_image', 'webpage_screenshot', 'webpage_media', 'bilibili_player', 'qq_group_image', 'qq_private_image'].includes(source?.kind)) throw new Error('SAVED_IMAGE_SOURCE_INVALID');
    const chatImage = source.kind.startsWith('qq_');
    if (chatImage && (source.kind !== (scope.startsWith('group:') ? 'qq_group_image' : 'qq_private_image')
      || !/^[a-f0-9]{32}$/.test(source.imageId) || typeof source.historical !== 'boolean')) throw new Error('SAVED_IMAGE_SOURCE_INVALID');
    shareable = !!shareable && publicSource(source);
    await assertMessageAccess(scope, this.store, source);
    const id = randomBytes(16).toString('hex');
    // Turn assets are removed by their lifecycle owner; 15 minutes is a crash fallback.
    const created = Date.now() - (source.temporary ? TTL - 15 * 60000 : 0);
    const asset = await this.access(scope, (db, key) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM images WHERE created<?').run(created - TTL);
        db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, key, created, clean(label), JSON.stringify(source), Number(shareable), mime, bytes.length, bytes);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      db.exec('PRAGMA incremental_vacuum(1024)');
      return { asset_id: id, label: clean(label), mimeType: mime, size: bytes.length,
        source, expiresAt: new Date(created + TTL).toISOString(), shareable };
    });
    await assertMessageAccess(scope, this.store, source);
    return asset;
  }
  async get(scope, id, { metadataOnly = false } = {}) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('SAVED_IMAGE_ID_INVALID');
    const image = await this.access(scope, (db, key) => {
      const fields = metadataOnly ? 'id,label,source,mime,size,created,shareable' : '*';
      const row = db.prepare(`SELECT ${fields} FROM images WHERE scope=? AND id=? AND created>=?`).get(key, id, Date.now() - TTL);
      if (!row) throw new Error('SAVED_IMAGE_NOT_RETAINED');
      return { ...imageMetadata(row), ...(metadataOnly ? {} : { bytes: Buffer.from(row.bytes) }) };
    });
    await assertMessageAccess(scope, this.store, image.source);
    return image;
  }
  async list(scope, query = '') {
    const images = await this.access(scope, (db, key) => db.prepare('SELECT id,label,source,mime,size,created,shareable FROM images WHERE scope=? AND created>=? ORDER BY created DESC,rowid DESC')
      .all(key, Date.now() - TTL).filter(row => !query || row.label.toLowerCase().includes(query.toLowerCase()))
      .map(row => ({ ...imageMetadata(row), size: row.size })));
    const visible = [];
    for (const image of images) {
      try { await assertMessageAccess(scope, this.store, image.source); visible.push(image); }
      catch (error) { if (error.message !== 'GROUP_MESSAGES_DISABLED') throw error; }
    }
    await assertMessageAccess(scope, this.store);
    return visible;
  }
  async remove(scope, id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('SAVED_IMAGE_ID_INVALID');
    return this.access(scope, (db, key) => {
      const result = db.prepare('DELETE FROM images WHERE scope=? AND id=?').run(key, id);
      db.exec('PRAGMA incremental_vacuum(1024)');
      return { deleted: result.changes > 0 };
    });
  }
  // Trusted turn cleanup must also work after permission revocation.
  async discard(scope, id) {
    return this.access(scope, (db, key) => db.prepare('DELETE FROM images WHERE scope=? AND id=?').run(key, id), { cleanup: true });
  }
  // Maintenance already owns authorization/cancellation; departed groups must be erasable.
  async clear(scope) {
    const dir = join(this.store.root, 'saved-images');
    const path = join(dir, 'images.sqlite');
    try { await stat(path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const db = new DatabaseSync(path, { timeout: 2500, allowExtension: false });
    try {
      db.exec('PRAGMA secure_delete=ON;');
      db.exec(SAVED_IMAGE_SCHEMA);
      db.prepare('DELETE FROM images WHERE scope=?').run(scopeId(scope));
      db.exec('PRAGMA incremental_vacuum(1024)');
    } finally { db.close(); }
  }
}
