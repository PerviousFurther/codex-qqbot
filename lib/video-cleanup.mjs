import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { action, controls, interaction } from './interaction.mjs';
import { withVideoLock } from './video-lock.mjs';
import { contextTime } from './context-time.mjs';

const week = 7 * 86400000;
const videoName = /^BV[a-zA-Z0-9]{10}\.json$/;
const scopeName = /^[a-f0-9]{32}$/;
const names = path => readdir(path).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const remove = path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
const time = value => value ? contextTime(value) + '（北京时间）' : '尚无';

// Retention and admin interaction are independent of model execution and group settings.
export class VideoCleanup {
  constructor(store, event) {
    this.store = store; this.event = event; this.path = join(store.root, 'video-cleanup.json');
    this.tail = Promise.resolve(); this.confirmations = new Map(); this.closed = false;
  }
  serial(task) {
    const result = this.tail.then(task); this.tail = result.catch(() => {}); return result;
  }
  async read() { return this.store.read(this.path, { enabled: true, nextAt: Date.now() + week }); }
  async start() {
    const state = await this.read();
    await this.store.write(this.path, state);
    this.arm(state);
  }
  arm(state) {
    clearTimeout(this.timer);
    if (this.closed || !state.enabled) return;
    this.timer = setTimeout(() => {
      this.serial(async () => {
        const current = await this.read();
        if (!current.enabled || this.closed) return;
        try {
          const counts = await this.clean(Date.now() - week);
          current.lastAt = Date.now(); current.lastCounts = counts; current.error = null;
          current.nextAt = Date.now() + week;
          this.event('video_cleanup_completed', { count: counts.details + counts.history });
        } catch {
          current.error = 'VIDEO_CLEANUP_FAILED'; current.nextAt = Date.now() + 3600000;
          this.event('video_cleanup_failed', { reason: current.error });
        }
        await this.store.write(this.path, current); this.arm(current);
      }).catch(() => {
        this.event('video_cleanup_failed', { reason: 'VIDEO_CLEANUP_STATE_FAILED' });
        this.arm({ enabled: true, nextAt: Date.now() + 3600000 });
      });
    }, Math.max(1, state.nextAt - Date.now()));
    this.timer.unref();
  }
  async clean(cutoff) {
    return withVideoLock(this.store, async () => {
      const counts = { details: 0, history: 0 };
      const expired = record => record && (cutoff === Infinity || Date.parse(record.updatedAt) < cutoff);
      const directory = join(this.store.root, 'videos');
      for (const scope of (await names(directory)).filter(name => scopeName.test(name))) {
        for (const name of (await names(join(directory, scope))).filter(name => videoName.test(name))) {
          const path = join(directory, scope, name);
          if (!expired(await this.store.readVideo(path, { locked: true }))) continue;
          await remove(path); counts.details++;
        }
      }
      const history = join(this.store.root, 'history');
      for (const name of (await names(history)).filter(name => videoName.test(name))) {
        const path = join(history, name);
        if (expired(await this.store.readVideo(path, { locked: true }))) { await remove(path); counts.history++; }
      }
      const activity = join(this.store.root, 'activity');
      for (const name of (await names(activity)).filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
        const path = join(activity, name); const record = await this.store.read(path, null);
        if (!record?.bvid || !videoName.test(`${record.bvid}.json`)) continue;
        if (!await this.store.readVideo(join(directory, name.slice(0, -5), `${record.bvid}.json`), { locked: true })) await remove(path);
      }
      return counts;
    });
  }
  async handle(scope, command) {
    return this.serial(async () => {
      const state = await this.read();
      if (command === '/videos clear') {
        for (const [key, value] of this.confirmations) if (value.until < Date.now()) this.confirmations.delete(key);
        const token = randomBytes(8).toString('hex');
        this.confirmations.set(scope, { token, until: Date.now() + 600000 });
        return interaction('将清空所有私聊和群聊的视频记录、摘要。此操作无法撤销。\n已有对话中的内容仍会保留，B站账号和收藏不受影响。', [
          [action('确认清空视频记录', `/videos confirm ${token}`)], [action('取消', '/videos')],
        ]);
      }
      let notice = '';
      if (command.startsWith('/videos confirm ')) {
        const pending = this.confirmations.get(scope); this.confirmations.delete(scope);
        if (!pending || pending.until < Date.now() || command !== `/videos confirm ${pending.token}`) {
          return interaction('确认已失效，请重新打开清理页面。', [[action('视频记录管理', '/videos')]]);
        }
        const counts = await this.clean(Infinity);
        notice = `已清理 ${counts.details} 份详细摘要、${counts.history} 条公共历史。\n正在浏览的视频之后仍可保存新记录。\n\n`;
      } else if (command === '/videos auto on' || command === '/videos auto off') {
        state.enabled = command.endsWith(' on');
        if (state.enabled) state.nextAt = Date.now() + week;
      } else if (command !== '/videos') return interaction('请通过视频管理按钮操作。', [[action('视频记录管理', '/videos')]]);
      else this.confirmations.delete(scope);
      await this.store.write(this.path, state); this.arm(state);
      return interaction(`${notice}## 视频记录\n每周自动清理：${state.enabled ? '开' : '关'}\n每 7 天检查一次，删除最后保存时间超过 7 天的视频摘要和公共历史。\n下次：${state.enabled ? time(state.nextAt) : '已关闭'}\n最近自动清理：${time(state.lastAt)}${state.error ? '\n上次清理未完成，可发送诊断报告帮助排查。' : ''}\n\n仅清理机器人保存的视频记录，不删除 B 站收藏或登录状态。`, [
        [action(`${state.enabled ? '关闭' : '开启'}每周清理`, `/videos auto ${state.enabled ? 'off' : 'on'}`)],
        [action('手动清空视频记录', '/videos clear')], [controls.history, action('返回数据管理', '/settings data')],
      ]);
    });
  }
  async close() { this.closed = true; clearTimeout(this.timer); await this.tail; }
}
