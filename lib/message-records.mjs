import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { imageType, MAX_IMAGE_BYTES } from './image-policy.mjs';
import { audioType } from './audio-policy.mjs';
import { scopeId, redactCredentials } from './policy.mjs';
import { contentCodecs } from './content-codecs.mjs';
import './message-codecs.mjs';
import { assertRecord, recordComponents, recordReferences } from './record.mjs';
import { captureMessageElements, rawMessageElements, messageReference } from './message-elements.mjs';
import { redactQQMediaUrls } from './qq-images.mjs';

export function hasMessageParts(message) {
  return !!(message.onebotParts?.length || message.content?.trim() || message.attachments?.length || message.refMsgIdx || message.raw?.message_reference?.message_id
    || message.mentions?.length || rawMessageElements(message).length || message.raw?.ark_data
    || Number.isInteger(message.msgType ?? message.raw?.message_type));
}
// Seven-day conversation-local message graph. Attachment URLs never leave this database.
export class MessageRecords {
  constructor(store, images) { this.store = store; this.images = images; this.connections = new Map(); }
  async database(scope) {
    if (!/^(group|c2c):.+/.test(scope)) throw new Error('CONVERSATION_NOT_ALLOWED');
    if (!this.connections.has(scope)) this.connections.set(scope, (async () => {
      const dir = join(this.store.root, 'message-records'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(join(dir, `${scopeId(scope)}.sqlite`), { timeout: 2500, allowExtension: false });
      try {
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576;
          CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,ref_idx TEXT,received INTEGER NOT NULL,historical INTEGER NOT NULL,body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS records_ref ON records(ref_idx);
          CREATE INDEX IF NOT EXISTS records_time ON records(received);
          CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,kind TEXT NOT NULL,url TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS reply_media(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS forward_refs(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,resource_id TEXT NOT NULL);
        `); return db;
      } catch (error) { db.close(); throw error; }
    })().catch(error => { this.connections.delete(scope); throw error; }));
    return this.connections.get(scope);
  }
  async find(scope, key) {
    const db = await this.database(scope);
    const row = db.prepare('SELECT * FROM records WHERE (id=? OR ref_idx=?) AND received>=? ORDER BY received DESC LIMIT 1')
      .get(key, key, Date.now() - 7 * 86400000);
    if (!row) return null;
    const record = assertRecord({ ...JSON.parse(redactQQMediaUrls(row.body)), historical: !!row.historical });
    if (scope.startsWith('group:')) {
      if (record.speaker) delete record.speaker.isBotAdmin;
      for (const component of recordComponents(record)) if (component.type === 'record' && component.speaker) delete component.speaker.isBotAdmin;
    }
    return record;
  }
  // Acquisition keys are private scoped storage, never record components.
  async forwardReference(scope, id) {
    return (await this.database(scope)).prepare(`SELECT f.*,r.received,r.historical FROM forward_refs f
      JOIN records r ON r.id=f.message_id WHERE f.id=? AND r.received>=?`)
      .get(id, Date.now() - 7 * 86400000) ?? null;
  }
  // Operator browsing uses retained top-level incoming records only.
  async list(scope, page = 1, limit = 8) {
    if (!Number.isInteger(page) || page < 1 || page > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('INVALID_DETAIL_PAGE');
    const db = await this.database(scope); const cutoff = Date.now() - 7 * 86400000;
    const where = "received>=? AND json_extract(body,'$.source') IN ('qq_group_message','qq_private_message')";
    const total = db.prepare(`SELECT COUNT(*) AS count FROM records WHERE ${where}`).get(cutoff).count;
    page = Math.min(page, Math.max(1, Math.ceil(total / limit)));
    const rows = db.prepare(`SELECT id FROM records WHERE ${where} ORDER BY received DESC,id DESC LIMIT ? OFFSET ?`)
      .all(cutoff, limit, (page - 1) * limit);
    const items = [];
    for (const row of rows) { const record = await this.find(scope, row.id); if (record) items.push(record); }
    return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
  }
  // Shared context returns bounded retained records and graph/media references.
  // Evidence acquisition and nested expansion stay with explicit detail tools.
  async contextPage(scope, { query = '', since = '', until = '', offset = 0, limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 80
      || typeof since !== 'string' || since.length > 40 || typeof until !== 'string' || until.length > 40
      || !Number.isInteger(offset) || offset < 0
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('CONTEXT_QUERY_INVALID');
    const from = since ? Date.parse(since) : Date.now() - 10 * 60000;
    const through = until ? Date.parse(until) : Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(through) || from > through) throw new Error('CONTEXT_QUERY_INVALID');
    const db = await this.database(scope);
    const rows = db.prepare(`SELECT id,received FROM records WHERE received>=? AND received<=?
      AND json_extract(body,'$.source') IN ('qq_group_message','qq_private_message','bot_reply')
      AND (?='' OR EXISTS (SELECT 1 FROM json_each(body,'$.components') AS c
        WHERE json_extract(c.value,'$.type')='text' AND instr(lower(json_extract(c.value,'$.text')),lower(?))>0))
      ORDER BY received DESC,id DESC LIMIT ? OFFSET ?`)
      .all(Math.max(from, Date.now() - 7 * 86400000), through, query, query, limit + 1, offset);
    const items = []; let size = 0;
    for (const row of rows.slice(0, limit)) {
      const record = await this.find(scope, row.id);
      if (!record) throw new Error('MESSAGE_NOT_RETAINED');
      const preview = contentCodecs.value('message.record', record).to('message.content').single();
      const item = { id: row.id, received: row.received, timestamp: record.timestamp ?? null,
        speaker: record.speaker?.openid ?? null, record: preview };
      const length = JSON.stringify(item).length;
      if (size + length > 12000) break;
      items.push(item); size += length;
    }
    return { items, nextOffset: rows.length > items.length ? offset + items.length : null };
  }

  // Only confirmed platform submissions are archived; transport callers retain
  // accepted-send facts even if this independent local write fails.
  async captureReply(scope, { text = '', media }, result = {}, assertAccess = async () => {}) {
    const db = await this.database(scope);
    await assertAccess();
    const id = `reply:${typeof result?.id === 'string' ? result.id.slice(0, 160) : randomUUID()}`;
    const components = [];
    if (text) components.push({ type: 'text', text: redactCredentials(text) });
    let mediaRow;
    if (media?.bytes && ['image', 'audio'].includes(media.type)) {
      const mediaId = createHash('sha256').update(`${scope}\0${id}`).digest('hex').slice(0, 32);
      const mime = media.type === 'image' ? imageType(media.bytes) : audioType(media.bytes);
      if (media.bytes.length > (media.type === 'image' ? MAX_IMAGE_BYTES : 8 * 1024 * 1024)) throw new Error('REPLY_MEDIA_TOO_LARGE');
      components.push({ type: media.type, id: mediaId, ...(media.type === 'image' ? { imageId: mediaId } : {}), readable: true });
      mediaRow = { id: mediaId, kind: media.type, mime, bytes: media.bytes };
    }
    const record = { type: 'record', messageId: id, source: 'bot_reply', direction: 'outgoing',
      timestamp: new Date().toISOString(), speaker: { role: 'assistant' }, components, untrusted: true };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO records(id,received,historical,body) VALUES(?,?,1,?)').run(id, Date.now(), JSON.stringify(record));
      if (mediaRow) db.prepare('INSERT OR IGNORE INTO reply_media(id,message_id,kind,mime,bytes) VALUES(?,?,?,?,?)')
        .run(mediaRow.id, id, mediaRow.kind, mediaRow.mime, mediaRow.bytes);
      this.prune(db); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return record;
  }
  prune(db) {
    const deleted = db.prepare('DELETE FROM records WHERE received<?').run(Date.now() - 7 * 86400000).changes;
    if (!deleted) return;
    db.exec('DELETE FROM attachments WHERE message_id NOT IN (SELECT id FROM records); DELETE FROM reply_media WHERE message_id NOT IN (SELECT id FROM records); DELETE FROM forward_refs WHERE message_id NOT IN (SELECT id FROM records)');
  }
  async replyMedia(scope, id, { metadataOnly = false } = {}) {
    const columns = metadataOnly ? 'm.id,m.message_id,m.kind,m.mime' : 'm.*';
    const row = (await this.database(scope)).prepare(`SELECT ${columns} FROM reply_media m JOIN records r ON r.id=m.message_id
      WHERE m.id=? AND r.received>=?`).get(id, Date.now() - 7 * 86400000);
    return row ? { ...row, ...(metadataOnly ? {} : { bytes: Buffer.from(row.bytes) }) } : null;
  }

  // Read one level only. Offset is over direct children, not a recursive tree.
  async detail(scope, id, { offset = 0, limit = 20, content_offset = 0, content_limit = 6000,
    projectRecord = value => value, assertAccess = async () => {} } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20
      || !Number.isSafeInteger(content_offset) || content_offset < 0
      || !Number.isInteger(content_limit) || content_limit < 1 || content_limit > 6000) throw new Error('INVALID_DETAIL_PAGE');
    await assertAccess();
    const record = await this.find(scope, id);
    if (!record) throw new Error('MESSAGE_NOT_RETAINED');
    await assertAccess(record);
    const message = contentCodecs.value('message.record', record).to('message.content', { expandCards: true }).single();
    // Apply shared-chat identity filtering before serialization: filtering the
    // surrounding object cannot sanitize identities inside an encoded string.
    const source = JSON.stringify(projectRecord(record));
    const contentPage = { format: 'message.record JSON', text: source.slice(content_offset, content_offset + content_limit),
      offset: content_offset, total: source.length,
      nextOffset: content_offset + content_limit < source.length ? content_offset + content_limit : null };
    const refs = recordReferences(record).filter(childId => childId !== record.messageId);
    const items = []; const checked = [record];
    let characters = JSON.stringify(message).length + JSON.stringify(contentPage).length;
    const budget = 24000 - 512; // Reserve space for the page envelope.
    if (characters > budget) throw new Error('DETAIL_TOO_LARGE');
    let next = offset;
    for (; next < refs.length && items.length < limit; next++) {
      await assertAccess();
      const child = await this.find(scope, refs[next]);
      if (child) await assertAccess(child);
      const item = child ? contentCodecs.value('message.record', child).to('message.content', { expandCards: true }).single() : { type: 'record_ref', messageId: refs[next], status: 'MESSAGE_NOT_RETAINED' };
      const size = JSON.stringify(item).length;
      if (characters + size > budget) {
        if (items.length) break;
        // Keep child pagination advancing; its complete content is available
        // through a separate explicit read of this retained messageId.
        const reference = { type: 'record_ref', messageId: refs[next], status: 'DETAIL_REQUIRED', detailTool: 'get_message_detail' };
        characters += JSON.stringify(reference).length; items.push(reference);
        if (child) checked.push(child);
        continue;
      }
      characters += size; items.push(item);
      if (child) checked.push(child);
    }
    // Access/retention can change while asynchronous reads are in progress.
    for (const row of checked) {
      await assertAccess(row);
      if (!await this.find(scope, row.messageId)) throw new Error('MESSAGE_NOT_RETAINED');
    }
    await assertAccess();
    return { message, contentPage, items, total: refs.length, offset, nextOffset: next < refs.length ? next : null };
  }
  async capture(scope, message, isBotAdmin, historical = false, { received = Date.now(), assertAccess = async () => {}, forwardReference = null } = {}) {
    const db = await this.database(scope);
    await assertAccess();
    const pending = new Map();
    const prepare = async (incoming, element = null) => {
      const cached = pending.get(incoming.messageId)?.record ?? await this.find(scope, incoming.messageId);
      if (cached) return cached;
      const imageRefs = incoming.images ?? await this.images.capture(scope, incoming, historical, { received, assertAccess });
      const elements = element ? element.elements : await captureMessageElements(scope, incoming, prepare);
      let quote = null;
      const reference = messageReference(incoming);
      // Delivered snapshots are the quote evidence, not a second forwarded copy.
      // An embedded snapshot's type alone does not assert another quoted body.
      if (elements?.relation === 'quote') elements.reference = reference;
      else if (reference || !element && (incoming.msgType ?? incoming.raw?.message_type) === 103) {
        let original = reference ? pending.get(reference)?.record ?? await this.find(scope, reference) : null;
        if (original?.historical && !historical) original = null;
        quote = { reference, source: original ? 'stored_message' : 'unavailable', messageId: original?.messageId ?? null,
          limitation: original ? null : '引用原文未投递或未保留，不能猜测' };
      }
      const decoded = contentCodecs.value('qq.message', incoming).to('message.record', {
        scope, imageRefs, isBotAdmin: element ? null : isBotAdmin, element, elements, quote,
      }).single();
      pending.set(incoming.messageId, decoded);
      return { ...decoded.record, historical };
    };
    const record = await prepare(message);
    if (!pending.size) return record;
    await assertAccess();
    // Publish the complete message graph in one transaction, not one per node.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (forwardReference) {
        const retained = db.prepare(`SELECT f.resource_id,r.received FROM forward_refs f JOIN records r ON r.id=f.message_id
          WHERE f.id=? AND f.message_id=? AND r.received>=?`).get(message.messageId, forwardReference.message_id, Date.now() - 7 * 86400000);
        if (!retained || retained.received !== received || retained.resource_id !== forwardReference.resource_id)
          throw new Error('MESSAGE_NOT_RETAINED');
      }
      const insertRecord = db.prepare('INSERT OR IGNORE INTO records(id,ref_idx,received,historical,body) VALUES(?,?,?,?,?)');
      const insertAttachment = db.prepare('INSERT OR IGNORE INTO attachments(id,message_id,kind,url) VALUES(?,?,?,?)');
      const insertForward = db.prepare('INSERT OR IGNORE INTO forward_refs(id,message_id,resource_id) VALUES(?,?,?)');
      for (const [id, { record: item, privateAttachments, privateForwards = [] }] of pending) {
        insertRecord.run(id, item.referenceIndex, received, Number(historical), JSON.stringify(item));
        for (const attachment of privateAttachments) insertAttachment.run(attachment.id, id, attachment.kind, attachment.url);
        for (const reference of privateForwards) insertForward.run(reference.id, id, reference.resourceId);
      }
      this.prune(db);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return record;
  }
  async listAttachments(scope, offset = 0, limit = 8) {
    const db = await this.database(scope);
    const cutoff = Date.now() - 7 * 86400000;
    const rows = db.prepare(`SELECT a.id,a.kind,r.received,r.historical FROM attachments a JOIN records r ON r.id=a.message_id
      WHERE r.received>=? ORDER BY r.received DESC,a.id LIMIT ? OFFSET ?`).all(cutoff, limit + 1, offset);
    const items = [];
    for (const row of rows.slice(0, limit)) {
      const detail = await this.attachmentDetail(scope, row.id);
      if (detail) items.push({ ...row, attachment: detail.attachment });
    }
    return { items, more: rows.length > limit };
  }
  async removeAttachment(scope, id) {
    const row = await this.attachmentDetail(scope, id);
    const db = await this.database(scope);
    db.prepare('DELETE FROM attachments WHERE id=?').run(id);
    if (row?.attachment.imageId) await this.images.remove(scope, row.attachment.imageId);
    return { deleted: true };
  }
  async attachment(scope, id) {
    const db = await this.database(scope);
    return db.prepare(`SELECT a.*,r.historical FROM attachments a JOIN records r ON r.id=a.message_id WHERE a.id=? AND r.received>=?`)
      .get(id, Date.now() - 7 * 86400000) ?? null;
  }
  // Metadata lookup also works when QQ supplied ASR but no downloadable URL.
  // Downloadable attachments use the indexed pointer, including repeated access
  // checks. The bounded JSON fallback handles platform ASR without a URL.
  async attachmentDetail(scope, id) {
    const pointer = await this.attachment(scope, id);
    if (pointer) {
      const record = await this.find(scope, pointer.message_id);
      const attachment = [...recordComponents(record)].find(item => item.id === id && ['image', 'audio', 'video', 'file'].includes(item.type));
      return attachment ? { messageId: record.messageId, historical: record.historical, attachment } : null;
    }
    const db = await this.database(scope);
    // Platform ASR can be retained without a downloadable attachment URL.
    const row = db.prepare(`SELECT r.id AS message_id FROM records r,json_each(r.body,'$.components') j
      WHERE json_extract(j.value,'$.id')=? AND r.received>=? LIMIT 1`)
      .get(id, Date.now() - 7 * 86400000);
    if (!row) return null;
    const record = await this.find(scope, row.message_id);
    const attachment = [...recordComponents(record)].find(item => item.id === id && ['image', 'audio', 'video', 'file'].includes(item.type));
    return attachment ? { messageId: record.messageId, historical: record.historical, attachment } : null;
  }
  async clear(scope) { const db = await this.database(scope); db.exec('BEGIN IMMEDIATE; DELETE FROM records; DELETE FROM attachments; DELETE FROM reply_media; DELETE FROM forward_refs; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)'); }
  async close() { for (const db of this.connections.values()) (await db).close(); this.connections.clear(); }
}
