import { publicReply } from './policy.mjs';

const tools = {
  list_files: '查找文件与笔记', read_file: '读取文件', save_file: '保存文件', delete_file: '删除文件',
  web_search: '联网搜索资料', web_open_page: '查阅搜索网页', web_find_page: '查找网页内容',
  check_pending_events: '读取新消息', wait_reply: '等待新消息', set_interrupt_guard: '调整打断保护',
  read_media: '读取视频或动态表情', close_media: '释放媒体资源', get_message_detail: '查看关联消息', get_audio_detail: '读取音频转写', get_image_detail: '查看聊天图片',
  read_webpage: '读取网页',
  render_webpage: '查看网页画面', get_player_text: '读取弹幕与字幕',
  send_reply: '发送消息',
  discover_videos: '检索推荐视频', select_video: '选择视频', get_subtitles: '读取字幕',
  get_frames: '读取画面', remember_video: '保存视频摘要', recall_videos: '查询视频摘要',
  recall_group_context: '查询本群记录', compact_group_context: '压缩本群话题摘要',
};

// Actual stage and tool events feed the authorized progress transport.
export class RequestUpdates {
  constructor(settings, reply, waiting = false, isActive = () => true) {
    this.settings = settings;
    this.reply = reply;
    this.isActive = isActive;
    this.pending = Promise.resolve();
    if (waiting) this.stage('waiting', '已收到请求，正在等待前一个任务结束。');
  }
  send(event, text) {
    if (this.closed || !this.isActive()) return;
    this.pending = this.pending.then(() => this.isActive() ? this.reply({ event, text: publicReply(text), isActive: this.isActive }) : undefined);
    // Channel reports delivery failures; keep callbacks from becoming unhandled rejections.
    this.pending = this.pending.catch(() => {});
  }
  stage(id, text) {
    if (this.lastPhase === id) return;
    this.lastPhase = id;
    if (this.settings.toolMonitor) this.send('progress', text);
  }
  update(event) {
    if (this.closed) return;
    if (event.kind === 'started') this.stage('started', '开始处理新消息。');
    if (event.kind === 'tool' && Object.hasOwn(tools, event.name)) {
      if (this.settings.toolMonitor) this.send('progress', `开始${tools[event.name]}。`);
    }
    if (event.kind === 'tool-result' && this.settings.toolMonitor && Object.hasOwn(tools, event.name)) {
      const status = { completed: '已完成', failed: '未能完成', interrupted: '已中断' }[event.status];
      if (status) {
        const elapsed = Number.isFinite(event.elapsedMs) ? `（用时 ${(Math.max(0, event.elapsedMs) / 1000).toFixed(1)} 秒）` : '';
        this.send('progress', `${tools[event.name]}${status}${elapsed}。`);
      }
    }
    if (event.kind === 'answer') this.stage('answer', '正在准备回复。');
  }
  async finish() {
    this.stage('finished', '本次处理已结束。');
    await this.close();
  }
  async close() {
    this.closed = true;
    await this.pending;
  }
}
