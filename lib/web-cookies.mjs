import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const cookieKey = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]);

function encodeCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.some(cookie => !cookie || typeof cookie.name !== 'string'
    || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string'))
    throw new Error('WEB_COOKIE_STATE_INVALID');
  // Chromium can return the same cookie with properties in a different order.
  // That representation change must not count as a new login or other update.
  return new Map(cookies.map(cookie => {
    const fields = Object.entries(cookie).sort(([a], [b]) => a.localeCompare(b));
    return [cookieKey(cookie), JSON.stringify(Object.fromEntries(fields))];
  }));
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const initialized = db => Boolean(db.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get());

// All MCP processes share one account jar. Transactions merge only local changes;
// closing a stale context cannot overwrite unrelated cookies or restore a logout.
export class WebCookies {
  constructor(store) { this.store = store; this.directory = join(store.root, 'web-cookies'); }
  async legacyCookies() {
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
      for (const [id, body] of encodeCookies(saved?.cookies)) initial.set(id, body);
    }
    return initial;
  }
  async database() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'shared.sqlite');
    try { await (await open(path, 'wx', 0o600)).close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS cookies (key TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY)');
      if (!initialized(db)) {
        const initial = await this.legacyCookies();
        transaction(db, () => {
          if (!initialized(db)) {
            const insert = db.prepare('INSERT INTO cookies(key,body) VALUES (?,?)');
            for (const [id, body] of initial) insert.run(id, body);
            db.exec("INSERT INTO metadata(key) VALUES ('initialized')");
          }
        });
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
    const next = encodeCookies(cookies), before = encodeCookies(previous);
    const db = await this.database();
    try {
      transaction(db, () => {
        const remove = db.prepare('DELETE FROM cookies WHERE key=? AND body=?');
        const write = db.prepare('INSERT INTO cookies(key,body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body');
        for (const [id, body] of before) if (!next.has(id)) remove.run(id, body);
        for (const [id, body] of next) if (before.get(id) !== body) write.run(id, body);
      });
    } finally { db.close(); }
  }
}
