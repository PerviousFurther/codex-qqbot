import { contentRecordName, readContentRecord } from './content-source.mjs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { action, controls, interaction } from './interaction.mjs';
import { publicReply, redactCredentials } from './policy.mjs';
import { withContentLock } from './content-lock.mjs';

export function contentShare(video) {
  return redactCredentials(`${video.title}\n${video.url}\n\n${video.comment || video.summary.slice(0, 260)}`);
}

export class History {
  constructor(store) { this.store = store; this.directory = join(store.root, 'history'); }
  async indexSavedContent() {
    return withContentLock(this.store, () => this.indexUnlocked());
  }
  async indexUnlocked() {
    // Index public-content records only. Conversation files and group transcripts are never read here.
    const directory = join(this.store.root, 'videos');
    let scopes;
    try { scopes = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const scope of scopes.filter(name => /^[a-f0-9]{32}$/.test(name))) {
      for (const name of await readdir(join(directory, scope))) {
        if (!contentRecordName.test(name)) continue;
        const video = await this.store.readContent(join(directory, scope, name), { locked: true });
        const existing = await this.store.readContent(join(this.directory, name), { locked: true });
        if (video && (!existing || existing.updatedAt < video.updatedAt)) await this.publish(video);
      }
    }
  }
  async publish(video) {
    video = readContentRecord(video);
    if (!contentRecordName.test(`${video.id}.json`)) throw new Error('INVALID_CONTENT_ID');
    const path = join(this.directory, `${video.id}.json`);
    const previous = await this.store.readContent(path, { locked: true });
    const record = { id: video.id, url: video.url, kind: video.kind, title: publicReply(String(video.title)).slice(0, 300),
      summary: publicReply(String(video.summary)).slice(0, 1200),
      comment: publicReply(video.comment || String(video.summary).slice(0, 160)).slice(0, 200),
      discoveredAt: previous?.discoveredAt ?? video.updatedAt ?? new Date().toISOString(),
      updatedAt: video.updatedAt ?? new Date().toISOString() };
    await this.store.write(path, record);
    return record;
  }
  async records(query = '', { locked = false } = {}) {
    let names;
    try { names = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return (await Promise.all(names.filter(name => contentRecordName.test(name))
      .map(name => this.store.readContent(join(this.directory, name), { locked }))))
      .filter(Boolean).map(readContentRecord)
      .filter(video => `${video.title}\n${video.summary}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async menu(requestedPage = 1) {
    const records = await this.records();
    const pages = Math.max(1, Math.ceil(records.length / 4));
    const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
    const items = records.slice((page - 1) * 4, page * 4);
    const rows = items.map(video => [action(video.title.slice(0, 9), `/content ${video.id}`)]);
    const navigation = [];
    if (page > 1) navigation.push(action('上一页', `/history ${page - 1}`));
    if (page < pages) navigation.push(action('下一页', `/history ${page + 1}`));
    navigation.push(controls.history); rows.push(navigation);
    return interaction(`浏览历史（${page}/${pages}）\n${items.length ? items.map(video => `${video.title}\n${video.url}`).join('\n\n') : '还没有保存的内容。'}\n\n选择内容查看短评，或直接发链接和问题继续聊。`, rows);
  }
}
