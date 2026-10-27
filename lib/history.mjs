import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { action, controls, interaction } from './interaction.mjs';
import { publicReply } from './policy.mjs';
import { withVideoLock } from './video-lock.mjs';

export function videoShare(video) {
  return publicReply(`${video.title}\nhttps://www.bilibili.com/video/${video.bvid}/\n\n${video.comment || video.summary.slice(0, 260)}`);
}

export class History {
  constructor(store) { this.store = store; this.directory = join(store.root, 'history'); }
  async indexSavedVideos() {
    return withVideoLock(this.store, () => this.indexUnlocked());
  }
  async indexUnlocked() {
    // Index video records only. Conversation files and group transcripts are never read here.
    const directory = join(this.store.root, 'videos');
    let scopes;
    try { scopes = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const scope of scopes.filter(name => /^[a-f0-9]{32}$/.test(name))) {
      for (const name of await readdir(join(directory, scope))) {
        if (!/^BV[a-zA-Z0-9]{10}\.json$/.test(name)) continue;
        const video = await this.store.readVideo(join(directory, scope, name), { locked: true });
        const existing = await this.store.readVideo(join(this.directory, name), { locked: true });
        if (video && (!existing || existing.updatedAt < video.updatedAt)) await this.publish(video);
      }
    }
  }
  async publish(video) {
    if (!/^BV[a-zA-Z0-9]{10}$/.test(video.bvid)) throw new Error('INVALID_BVID');
    const path = join(this.directory, `${video.bvid}.json`);
    const previous = await this.store.readVideo(path, { locked: true });
    const record = { bvid: video.bvid, title: publicReply(String(video.title)).slice(0, 300),
      summary: publicReply(String(video.summary)).slice(0, 1200),
      comment: publicReply(video.comment || String(video.summary).slice(0, 160)).slice(0, 200),
      discoveredAt: previous?.discoveredAt ?? video.updatedAt ?? new Date().toISOString(),
      updatedAt: video.updatedAt ?? new Date().toISOString() };
    await this.store.write(path, record);
    return record;
  }
  async records(query = '') {
    let names;
    try { names = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return (await Promise.all(names.filter(name => /^BV[a-zA-Z0-9]{10}\.json$/.test(name))
      .map(name => this.store.readVideo(join(this.directory, name)))))
      .filter(video => video && `${video.title}\n${video.summary}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async menu(requestedPage = 1) {
    const records = await this.records();
    const pages = Math.max(1, Math.ceil(records.length / 4));
    const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
    const items = records.slice((page - 1) * 4, page * 4);
    const rows = items.map(video => [action(video.title.slice(0, 9), `/video ${video.bvid}`)]);
    const navigation = [];
    if (page > 1) navigation.push(action('上一页', `/history ${page - 1}`));
    if (page < pages) navigation.push(action('下一页', `/history ${page + 1}`));
    navigation.push(controls.history); rows.push(navigation);
    return interaction(`浏览历史（${page}/${pages}）\n${items.length ? items.map(video => `${video.title}\nhttps://www.bilibili.com/video/${video.bvid}/`).join('\n\n') : '还没有保存的视频。'}\n\n选择视频查看短评，或直接发链接和问题继续聊。`, rows);
  }
}
