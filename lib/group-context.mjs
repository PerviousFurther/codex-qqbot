import { recordComponents } from './record.mjs';
import { contentCodecs } from './content-codecs.mjs';
import './message-codecs.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scopeId, redactCredentials } from './policy.mjs';
import { contextTime } from './context-time.mjs';

const retentionMs = 7 * 86400000;
const storedJSON = text => {
  try { return JSON.parse(text); }
  catch { throw new Error('GROUP_RECORD_FORMAT_INVALID'); }
};
const previewText = row => row.text?.length > 1200 ? `[Folded ${row.text.length} characters: ${row.id}]` : row.text;
const rowSize = (db, row) => {
  const body = db.prepare("SELECT body FROM message_details WHERE message_id=? AND json_extract(body,'$.type')='record' AND json_type(body,'$.components')='array'").get(row.id)?.body;
  const message = body ? contentCodecs.value('message.record', storedJSON(body)).to('message.content').single() : null;
  return JSON.stringify({ ...row, text: previewText(row), message }).length + 256;
};
const stamp = value => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('INVALID_RECORD_TIME');
  return parsed;
};
const cleanName = value => redactCredentials(String(value || '昵称未提供'))
  .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);

// Indexed group-local records, shared safely by the bot and its MCP subprocesses.
export class GroupContext {
  constructor(store) { this.store = store; this.connections = new Map(); }
  database(scope) {
    if (!scope.startsWith('group:')) throw new Error('GROUP_SCOPE_REQUIRED');
    if (!this.connections.has(scope)) {
      const opening = this.open(scope).catch(error => { this.connections.delete(scope); throw error; });
      this.connections.set(scope, opening);
    }
    return this.connections.get(scope);
  }
  async open(scope) {
    const directory = join(this.store.root, 'group-context');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${scopeId(scope)}.sqlite`);
    const db = new DatabaseSync(path, { timeout: 2500, allowExtension: false });
    try {
      const hadInputReceipts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_inputs'").get();
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=1048576;
        CREATE TABLE IF NOT EXISTS state (
          id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
          version INTEGER NOT NULL DEFAULT 0, summarized INTEGER NOT NULL DEFAULT 0, compact_requested INTEGER NOT NULL DEFAULT 0,
          updated INTEGER NOT NULL DEFAULT 0, expired_uncompacted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS messages (
          revision INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, openid TEXT NOT NULL,
          name TEXT NOT NULL, timestamp INTEGER NOT NULL, received INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY CHECK(id=1), processed INTEGER NOT NULL DEFAULT 0, idle_reserved INTEGER NOT NULL DEFAULT 0, last_batch INTEGER NOT NULL DEFAULT 0, last_human INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO activity(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS model_inputs (message_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS message_lengths (id TEXT PRIMARY KEY,chars INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS message_images (message_id TEXT PRIMARY KEY,refs TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS message_details (message_id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (openid TEXT PRIMARY KEY,name TEXT NOT NULL,last_seen INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS member_time ON messages(openid,timestamp,revision);
        CREATE INDEX IF NOT EXISTS message_time ON messages(timestamp,revision);
        CREATE INDEX IF NOT EXISTS message_received ON messages(received);
        CREATE INDEX IF NOT EXISTS members_seen ON members(last_seen);`);
      db.prepare('INSERT OR IGNORE INTO state(id,epoch) VALUES(1,?)').run(randomUUID());
      if (!hadInputReceipts) {
        const seen = (await this.store.conversation(scope)).seen ?? [];
        this.transaction(db, () => {
          db.exec('INSERT OR IGNORE INTO model_inputs(message_id) SELECT id FROM messages WHERE revision<=(SELECT processed FROM activity WHERE id=1)');
          const insert = db.prepare('INSERT OR IGNORE INTO model_inputs(message_id) SELECT id FROM messages WHERE id=?');
          for (const id of seen) insert.run(id);
        });
      }
      return db;
    } catch (error) { db.close(); throw error; }
  }
  transaction(db, action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  prune(db) {
    const cutoff = Date.now() - retentionMs;
    const missing = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE revision>(SELECT summarized FROM state WHERE id=1) AND received<?')
      .get(cutoff).count;
    if (missing) db.prepare('UPDATE state SET expired_uncompacted=expired_uncompacted+? WHERE id=1').run(missing);
    const deleted = db.prepare('DELETE FROM messages WHERE received<?').run(cutoff).changes;
    db.prepare('DELETE FROM members WHERE last_seen<?').run(cutoff);
    if (!deleted) return;
    db.exec('DELETE FROM model_inputs WHERE message_id NOT IN (SELECT id FROM messages)');
    db.exec('DELETE FROM message_lengths WHERE id NOT IN (SELECT id FROM messages)');
    db.exec('DELETE FROM message_images WHERE message_id NOT IN (SELECT id FROM messages)');
    db.exec('DELETE FROM message_details WHERE message_id NOT IN (SELECT id FROM messages)');
  }
  async clear(scope) {
    const db = await this.database(scope);
    this.transaction(db, () => {
      db.exec('DELETE FROM messages; DELETE FROM model_inputs; DELETE FROM message_lengths; DELETE FROM message_images; DELETE FROM message_details; DELETE FROM members; DELETE FROM activity; INSERT INTO activity(id) VALUES(1)');
      db.prepare("UPDATE state SET epoch=?,summary='',version=version+1,summarized=0,compact_requested=0,updated=0,expired_uncompacted=0 WHERE id=1").run(randomUUID());
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  async append(message) {
    if (!message.content?.trim() && !message.images?.length && !message.structure) return;
    const db = await this.database(`group:${message.groupOpenid}`);
    const parsed = Date.parse(message.timestamp);
    const time = Number.isFinite(parsed) ? Math.min(parsed, Date.now() + 120000) : Date.now();
    this.transaction(db, () => {
      const inserted = db.prepare('INSERT OR IGNORE INTO messages(id,openid,name,timestamp,received,text) VALUES(?,?,?,?,?,?)')
        .run(message.messageId, message.senderId, cleanName(message.senderName), time, Date.now(),
          redactCredentials(message.content?.trim() ? message.content : ([...recordComponents(message.structure)].some(item => item.relation === 'forwarded') ? '［内嵌聊天记录或转发消息，按messageId读取内容］' : '［引用或附件消息］')));
      if (inserted.changes) {
        db.prepare('UPDATE activity SET last_human=? WHERE id=1').run(Date.now());
        db.prepare('INSERT OR IGNORE INTO message_lengths(id,chars) VALUES(?,?)').run(message.messageId, message.content?.length ?? 0);
        const record = message.structure ?? contentCodecs.value('qq.message', message).to('message.record', {
          scope: `group:${message.groupOpenid}`, imageRefs: message.images ?? [],
        }).single().record;
        db.prepare('INSERT OR IGNORE INTO message_details(message_id,body) VALUES(?,?)')
          .run(message.messageId, JSON.stringify({ ...record, botMentioned: message.botMentioned === true }));
        if (message.images?.length) db.prepare('INSERT OR IGNORE INTO message_images(message_id,refs) VALUES(?,?)').run(message.messageId, JSON.stringify(message.images));
      }
      db.prepare('INSERT OR REPLACE INTO members(openid,name,last_seen) VALUES(?,?,?)')
        .run(message.senderId, cleanName(message.senderName), time);
      this.prune(db);
    });
  }
  decorate(rows, db) {
    return rows.map(row => {
      const detail = db && row.id ? {
        message: contentCodecs.value('message.record',
          storedJSON(db.prepare("SELECT body FROM message_details WHERE message_id=? AND json_extract(body,'$.type')='record' AND json_type(body,'$.components')='array'").get(row.id)?.body ?? 'null'))
          .to('message.content').single(),
      } : {};
      if (db && row.id) detail.images = detail.message ? []
        : storedJSON(db.prepare('SELECT refs FROM message_images WHERE message_id=?').get(row.id)?.refs ?? '[]');
      return { messageId: row.id, revision: row.revision, name: row.name, openid: row.openid,
        timestamp: contextTime(row.timestamp), text: previewText(row), ...detail };
    });
  }
  async snapshot(scope, { batch = false, contextMinutes = 10 } = {}) {
    const db = await this.database(scope);
    this.transaction(db, () => this.prune(db));
    const now = Date.now(); const since = now - contextMinutes * 60000;
    const state = db.prepare('SELECT * FROM state WHERE id=1').get();
    const candidates = batch ? db.prepare('SELECT * FROM messages m WHERE timestamp>=? AND NOT EXISTS (SELECT 1 FROM model_inputs i WHERE i.message_id=m.id) ORDER BY revision ASC LIMIT 40').all(since) : [];
    const recent = []; let characters = 0;
    for (const row of candidates) {
      const size = rowSize(db, row);
      if (characters + size > 12000) break;
      recent.push(row); characters += size;
    }
    const pending = db.prepare('SELECT COUNT(*) AS count,MIN(timestamp) AS oldest FROM messages WHERE revision>?').get(state.summarized);
    const speakerIds = [...new Set(recent.map(row => row.openid))];
    const roster = speakerIds.map(openid => db.prepare('SELECT openid,name,last_seen AS timestamp FROM members WHERE openid=?').get(openid)).filter(Boolean);
    const participants = this.decorate(roster).map(({ text, revision, ...person }) => person);
    // A cumulative summary can contain older originals; keep it behind explicit retrieval.
    const latestRevision = recent.at(-1)?.revision ?? 0;
    return { now: contextTime(now), timezone: 'Asia/Shanghai', timestampFormat: 'YY/MM/DD-HH:mm',
      contextMinutes, contextSince: new Date(since).toISOString(),
      oldestContextAt: recent.length ? Math.min(...recent.map(row => row.timestamp)) : now,
      summaryAvailable: !!state.summary,
      epoch: state.epoch, latestRevision, batchWindow: batch,
      summaryThroughRevision: state.summarized, uncompactedMessages: pending.count,
      oldestUncompactedAt: pending.oldest ? contextTime(pending.oldest) : null,
      compactionSuggested: pending.count >= 24 || !!pending.oldest && now - pending.oldest >= 600000,
      expiredUncompactedMessages: state.expired_uncompacted,
      retention: { days: 7 }, participants,
      messages: this.decorate(recent, db),
      tools: 'Only messages inside contextMinutes are supplied automatically. Use recall_group_context with explicit ISO-8601 dates to retrieve older retained records or prepare compaction; compact_group_context saves a summary without deleting originals.' };
  }
  async recall(scope, { openid = '', query = '', since = '', until = '', before_revision = 0, limit = 20,
    for_compaction = false } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 40 || !Number.isSafeInteger(before_revision) || before_revision < 0) throw new Error('INVALID_RECORD_QUERY');
    if (for_compaction && (openid || query || since || before_revision)) throw new Error('COMPACTION_REQUIRES_UNFILTERED_PREFIX');
    const db = await this.database(scope);
    const fromTime = since ? stamp(since) : Date.now() - 10 * 60000;
    const toTime = until ? stamp(until) : Date.now();
    if (fromTime > toTime) throw new Error('INVALID_TIME_WINDOW');
    const selection = this.transaction(db, () => {
      const state = db.prepare('SELECT * FROM state WHERE id=1').get();
      const clauses = ['received>=?']; const params = [Date.now() - retentionMs];
      if (for_compaction) { clauses.push('revision>?'); params.push(state.summarized); }
      else {
        clauses.push('timestamp>=? AND timestamp<=?'); params.push(fromTime, toTime);
        if (openid) { clauses.push('openid=?'); params.push(openid); }
        if (query) { clauses.push('instr(lower(text),lower(?))>0'); params.push(query); }
        if (before_revision) { clauses.push('revision<?'); params.push(before_revision); }
      }
      const rows = db.prepare(`SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY revision ${for_compaction ? 'ASC' : 'DESC'} LIMIT ?`).all(...params, limit + 1);
      const selected = []; let length = 0;
      for (const row of rows.slice(0, limit)) {
        if (for_compaction && row.timestamp > toTime) break;
        const size = rowSize(db, row);
        if (length + size > 12000) break;
        selected.push(row); length += size;
      }
      return { state, selected, more: rows.length > selected.length };
    });
    const { state, selected, more } = selection;
    const messages = this.decorate(for_compaction ? selected : [...selected].reverse(), db);
    const member = openid ? db.prepare('SELECT openid,name,last_seen AS timestamp FROM members WHERE openid=?').get(openid) : null;
    const person = member ? this.decorate([member])[0] : null;
    return { now: contextTime(Date.now()), timezone: 'Asia/Shanghai', timestampFormat: 'YY/MM/DD-HH:mm',
      ...(for_compaction ? { summary: state.summary } : { summaryAvailable: !!state.summary }),
      summaryScope: 'Whole current group; not restricted to the queried member or time range.',
      summaryThroughRevision: state.summarized, member: person, messages, more,
      nextBeforeRevision: !for_compaction && more && selected.length ? selected.at(-1).revision : null,
      retention: { days: 7 }, expiredUncompactedMessages: state.expired_uncompacted,
      receipt: for_compaction && selected.length ? { epoch: state.epoch, version: state.version,
        fromRevision: state.summarized, throughRevision: selected.at(-1).revision, count: selected.length } : null };
  }
  async compact(scope, receipt, summary) {
    if (!summary?.trim() || summary.length > 1500) throw new Error('INVALID_GROUP_SUMMARY');
    const db = await this.database(scope);
    return this.transaction(db, () => {
      const state = db.prepare('SELECT * FROM state WHERE id=1').get();
      if (state.epoch !== receipt.epoch || state.version !== receipt.version || state.summarized !== receipt.fromRevision) throw new Error('GROUP_SUMMARY_STALE');
      const count = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE revision>? AND revision<=?').get(receipt.fromRevision, receipt.throughRevision).count;
      if (count !== receipt.count) throw new Error('GROUP_RECORDS_EXPIRED');
      db.prepare('UPDATE state SET summary=?,summarized=?,compact_requested=version+1,version=version+1,updated=? WHERE id=1')
        .run(redactCredentials(summary), receipt.throughRevision, Date.now());
      return { saved: true, throughRevision: receipt.throughRevision, originalsRetained: true, contextCompactionQueued: true };
    });
  }
  async markSupplied(scope, messageIds, epoch) {
    const db = await this.database(scope);
    this.transaction(db, () => {
      if (db.prepare('SELECT epoch FROM state WHERE id=1').get().epoch !== epoch) throw new Error('GROUP_CONTEXT_EXPIRED');
      const insert = db.prepare('INSERT OR IGNORE INTO model_inputs(message_id) SELECT id FROM messages WHERE id=?');
      for (const id of messageIds) insert.run(id);
    });
  }
  async batchStatus(scope, { contextMinutes = 10 } = {}) {
    const db = await this.database(scope);
    const activity = db.prepare('SELECT * FROM activity WHERE id=1').get();
    const pending = db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(COALESCE(l.chars,length(m.text))),0) AS chars,COALESCE(MIN(m.received),0) AS first,COALESCE(MIN(m.revision),0) AS first_revision,COALESCE(SUM(json_extract(d.body,'$.botMentioned')=1),0) AS mentions FROM messages m LEFT JOIN message_lengths l ON m.id=l.id LEFT JOIN message_details d ON m.id=d.message_id WHERE m.timestamp>=? AND NOT EXISTS (SELECT 1 FROM model_inputs i WHERE i.message_id=m.id)`).get(Date.now() - contextMinutes * 60000);
    const latest = db.prepare('SELECT COALESCE(MAX(revision),0) AS revision,COALESCE(MAX(received),0) AS last FROM messages').get();
    const state = db.prepare('SELECT epoch FROM state WHERE id=1').get();
    return { epoch: state.epoch, latestRevision: latest.revision, lastMessageAt: activity.last_human || latest.last,
      pendingCount: pending.count, pendingChars: pending.chars, pendingMentions: pending.mentions, firstPendingAt: pending.first, firstPendingRevision: pending.first_revision,
      lastBatchAt: activity.last_batch, idleReserved: activity.idle_reserved, retryAt: activity.retry_at };
  }
  async acknowledgeBatch(scope, revision, epoch) {
    const db = await this.database(scope);
    db.prepare('UPDATE activity SET processed=MAX(processed,?),last_batch=?,retry_at=0 WHERE id=1 AND ?=(SELECT epoch FROM state WHERE id=1)')
      .run(revision, Date.now(), epoch);
  }
  async claimIdle(scope, anchor) {
    const db = await this.database(scope);
    return this.transaction(db, () => {
      const last = db.prepare('SELECT last_human AS last FROM activity WHERE id=1').get().last
        || db.prepare('SELECT COALESCE(MAX(received),0) AS last FROM messages').get().last;
      const reserved = db.prepare('SELECT idle_reserved AS anchor FROM activity WHERE id=1').get().anchor;
      if (reserved === anchor || last > anchor) return false;
      db.prepare('UPDATE activity SET idle_reserved=? WHERE id=1').run(anchor); return true;
    });
  }
  async deferBatch(scope, delayMs) {
    const db = await this.database(scope);
    db.prepare('UPDATE activity SET retry_at=? WHERE id=1').run(Date.now() + delayMs);
  }
  async contextCompactionRequest(scope) {
    const db = await this.database(scope);
    return db.prepare('SELECT compact_requested AS version FROM state WHERE id=1').get().version;
  }
  async acknowledgeCompaction(scope, version) {
    const db = await this.database(scope);
    db.prepare('UPDATE state SET compact_requested=0 WHERE id=1 AND compact_requested=?').run(version);
  }
  async close() {
    for (const pending of this.connections.values()) (await pending).close();
    this.connections.clear();
  }
}
