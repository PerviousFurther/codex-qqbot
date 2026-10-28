import { mkdir, readFile, writeFile, rename, opendir, stat, link, unlink, open } from 'node:fs/promises';
import { resolve, join, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentSource, contentRecordName, readContentRecord } from './content-source.mjs';
import { History } from './history.mjs';
import { withContentLock } from './content-lock.mjs';
import { scopeId } from './policy.mjs';

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); }
  finally { await directory.close(); }
}

export async function writeAtomic(path, content, { replace = true } = {}) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = join(resolve(path, '..'), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
    await syncDirectory(resolve(path, '..'));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export class Store {
  constructor(root = '.state') { this.root = resolve(root); }
  async read(path, fallback) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) throw new Error('STATE_JSON_CORRUPT');
      throw error;
    }
  }
  async write(path, value) {
    return writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
  }
  async readContent(path, { locked = false } = {}) {
    if (!/^(?:videos\/[a-f0-9]{32}|history)\/(?:BV[a-zA-Z0-9]{10}|[a-f0-9]{32})\.json$/.test(relative(this.root, resolve(path))))
      throw new Error('INVALID_VIDEO_RECORD_PATH');
    try { return await this.read(path, null); }
    catch (error) {
      if (error.message !== 'STATE_JSON_CORRUPT') throw error;
      const removeCorrupt = async () => {
        // Re-read under the shared video lock: a writer may have replaced the
        // corrupt record since the first read. Never delete that valid update.
        try { return await this.read(path, null); }
        catch (current) { if (current.message !== 'STATE_JSON_CORRUPT') throw current; }
        await unlink(path);
        await syncDirectory(resolve(path, '..'));
        console.error(JSON.stringify({ state: 'video_record_corrupt_deleted', reason: 'VIDEO_RECORD_CORRUPT', count: 1 }));
        this.onVideoRecordError?.();
        return null;
      };
      return locked ? removeCorrupt() : withContentLock(this, removeCorrupt);
    }
  }
  async firstAdmin() {
    const record = await this.read(join(this.root, 'admin.json'), null);
    if (record === null) return null;
    if (typeof record.openid !== 'string' || !record.openid.trim()) throw new Error('INVALID_ADMIN_RECORD');
    return record.openid;
  }
  async claimFirstAdmin(openid) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, 'admin.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ openid, boundAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx', flush: true });
      try {
        // Publish a complete record without replacing a concurrent winner.
        await link(temporary, path);
        await syncDirectory(this.root);
        return { openid, claimed: true };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        return { openid: await this.firstAdmin(), claimed: false };
      }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  conversationPath(scope) { return join(this.root, 'conversations', `${scopeId(scope)}.json`); }
  conversation(scope) { return this.read(this.conversationPath(scope), { model: null, threadId: null, seen: [] }); }
  saveConversation(scope, value) { return this.write(this.conversationPath(scope), value); }
  activityPath(scope) { return join(this.root, 'activity', `${scopeId(scope)}.json`); }
  activity(scope) { return this.read(this.activityPath(scope), null); }
  saveActivity(scope, value) { return this.write(this.activityPath(scope), { ...value, updatedAt: new Date().toISOString() }); }
  contentPath(scope, id) {
    if (!contentRecordName.test(`${id}.json`)) throw new Error('INVALID_CONTENT_ID');
    return join(this.root, 'videos', scopeId(scope), `${id}.json`);
  }
  async remember(scope, video, { beforePublish = async () => {} } = {}) {
    const record = {
      ...contentSource(video.url), kind: ['webpage', 'video', 'audio'].includes(video.kind) ? video.kind : 'webpage', title: String(video.title).slice(0, 300),
      summary: String(video.summary).slice(0, 6000),
      comment: String(video.comment ?? '').slice(0, 200),
      observations: (video.observations ?? []).slice(0, 12).map(item => ({
        seconds: Number(item.seconds), text: String(item.text).slice(0, 500),
      })),
      uncertainty: String(video.uncertainty ?? '').slice(0, 1000),
      updatedAt: new Date().toISOString(),
    };
    if (!record.summary || record.observations.some(item => !Number.isFinite(item.seconds) || item.seconds < 0)) throw new Error('INVALID_CONTENT_MEMORY');
    await withContentLock(this, async () => {
      const existing = (await new History(this).records('', { locked: true })).find(item => item.url === record.url);
      if (existing) record.id = existing.id;
      await beforePublish();
      await this.write(this.contentPath(scope, record.id), record);
      await beforePublish();
      await new History(this).publish(record);
    });
    return record;
  }
  async memories(scope, limit = 6, query = '') {
    const directory = join(this.root, 'videos', scopeId(scope));
    let entries;
    try { entries = await opendir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const recent = [];
    for await (const entry of entries) {
      if (!entry.isFile() || !contentRecordName.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (query) {
        const record = await this.readContent(path);
        if (!record || !`${record.title}\n${record.summary}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      }
      const modified = (await stat(path)).mtimeMs;
      recent.push({ path, modified });
      recent.sort((a, b) => b.modified - a.modified);
      if (recent.length > limit) recent.pop();
    }
    return (await Promise.all(recent.map(item => this.readContent(item.path)))).filter(Boolean).map(readContentRecord);
  }
  async context(scope, budget = 12000, query = '') {
    const records = await this.memories(scope, 6, query);
    const selected = [];
    let length = 2;
    for (const record of records) {
      const size = JSON.stringify(record).length + 1;
      if (length + size > budget) continue;
      selected.push(record);
      length += size;
    }
    return selected;
  }
}
