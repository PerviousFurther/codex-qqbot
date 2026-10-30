import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const key = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]);
const encode = cookies => {
  if (!Array.isArray(cookies) || cookies.some(cookie => !cookie || typeof cookie.name !== 'string'
    || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string'))
    throw new Error('WEB_COOKIE_STATE_INVALID');
  // Chromium can return the same cookie with properties in a different order.
  // That representation change must not count as a new login or other update.
  return new Map(cookies.map(cookie => [key(cookie), JSON.stringify(Object.fromEntries(Object.entries(cookie).sort(([a], [b]) => a.localeCompare(b))))]));
};

// All MCP processes share one account jar. Transactions merge only local changes;
// closing a stale context cannot overwrite unrelated cookies or restore a logout.
export class WebCookies {
  constructor(store) { this.store = store; this.directory = join(store.root, 'web-cookies'); }
  async database() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'shared.sqlite');
    try { await (await open(path, 'wx', 0o600)).close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS cookies (key TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY)');
      if (!db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) {
        const entries = await readdir(this.directory, { withFileTypes: true });
        const legacy = [];
        for (const entry of entries) {
          if (!entry.isFile() || !/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
          const path = join(this.directory, entry.name);
          legacy.push({ path, time: (await stat(path)).mtimeMs });
        }
        legacy.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
        const initial = new Map();
        for (const entry of legacy) {
          const saved = await this.store.read(entry.path, { cookies: [] });
          for (const [id, body] of encode(saved?.cookies)) initial.set(id, body);
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) {
            const insert = db.prepare('INSERT INTO cookies(key,body) VALUES (?,?)');
            for (const [id, body] of initial) insert.run(id, body);
            db.exec("INSERT INTO metadata(key) VALUES ('initialized')");
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return db;
    } catch (error) { db.close(); throw error; }
  }
  async load() {
    const db = await this.database();
    try { return db.prepare('SELECT body FROM cookies ORDER BY key').all().map(row => JSON.parse(row.body)); }
    finally { db.close(); }
  }
  async save(cookies, previous = []) {
    const next = encode(cookies), before = encode(previous);
    const db = await this.database();
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const remove = db.prepare('DELETE FROM cookies WHERE key=? AND body=?');
        const write = db.prepare('INSERT INTO cookies(key,body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body');
        for (const [id, body] of before) if (!next.has(id)) remove.run(id, body);
        for (const [id, body] of next) if (before.get(id) !== body) write.run(id, body);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
}
