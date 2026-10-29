import { publicReply } from './policy.mjs';
import { webFeedbackUrls } from './web-feedback.mjs';

const webTools = new Set(['web_search', 'web_open_page', 'web_find_page', 'read_webpage', 'open_webpage', 'scroll_webpage', 'screenshot_webpage', 'close_webpage', 'click_webpage', 'type_webpage', 'press_webpage', 'back_webpage', 'get_webpage_dom', 'edit_webpage_dom']);
const webDetails = event => {
  if (!webTools.has(event.name)) return '';
  const urls = webFeedbackUrls(Array.isArray(event.urls) ? event.urls : []);
  if (urls.length) return `\n网址（已去除查询参数和片段，最多三条）：\n${urls.join('\n')}`;
  return event.kind === 'tool-result' && event.name === 'web_search' ? '\n搜索事件未提供可展示的网址。' : '';
};

const tools = {
  list_files: '查找文件与笔记', read_file: '读取文件', save_file: '保存文件', delete_file: '删除文件',
  web_search: '联网搜索资料', web_open_page: '查阅搜索网页', web_find_page: '查找网页内容',
  check_pending_events: '读取新消息', wait_reply: '等待新消息', set_interrupt_guard: '调整打断保护',
  read_media: '读取视频或动态表情', close_media: '释放媒体资源', get_message_detail: '查看关联消息', get_audio_detail: '读取音频转写', get_image_detail: '查看聊天图片',
  read_webpage: '读取网页',
  open_webpage: '打开网页', scroll_webpage: '滚动网页', screenshot_webpage: '截取网页画面', close_webpage: '关闭网页',
  get_webpage_dom: '读取网页元素', edit_webpage_dom: '移除或隐藏网页元素',
  click_webpage: '点击网页', type_webpage: '输入网页文字', press_webpage: '操作网页按键', back_webpage: '返回上一网页',
  send_reply: '发送消息或互动',
  list_context_chats: '查找可共享的聊天', read_chat_context: '查询其他聊天上下文', search_qq_history: '搜索 QQ 历史消息', search_qq_faces: '查询 QQ 表情名称',
  upload_file: '向网页选择上传文件', list_webpage_media: '查找网页播放器',
  read_webpage_media: '读取网页媒体画面', get_webpage_subtitles: '读取网页字幕',
  remember_content: '保存内容摘要', recall_content: '查询内容摘要',
  recall_group_context: '查询本群记录', compact_group_context: '压缩本群话题摘要',
};
const noteTools = { list_files: '查找笔记', read_file: '读取笔记', save_file: '保存笔记', delete_file: '删除笔记' };
const fileKinds = { text: '文本文件', image: '图片', gif: '动态图片', audio: '音频', video: '视频', no_extension: '无后缀文件', binary: '文件（未知后缀）' };
const toolLabel = event => {
  if (!Object.hasOwn(noteTools, event.name)) return tools[event.name];
  if (event.memoryNote === true) return noteTools[event.name];
  if (!Object.hasOwn(fileKinds, event.fileKind)) return tools[event.name];
  const kind = event.fileKind === 'binary' && /^[a-z0-9]{1,16}$/.test(event.fileExtension ?? '')
    ? `文件（未知后缀 ${event.fileExtension}）` : fileKinds[event.fileKind];
  return `${{ list_files: '查找', read_file: '读取', save_file: '保存', delete_file: '删除' }[event.name]}${kind}`;
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
      if (this.settings.toolMonitor) this.send('progress', `开始${toolLabel(event)}。${webDetails(event)}`);
    }
    if (event.kind === 'tool-result' && this.settings.toolMonitor && Object.hasOwn(tools, event.name)) {
      const status = { completed: '已完成', failed: '未能完成', interrupted: '已中断' }[event.status];
      if (status) {
        const elapsed = Number.isFinite(event.elapsedMs) ? `（用时 ${(Math.max(0, event.elapsedMs) / 1000).toFixed(1)} 秒）` : '';
        this.send('progress', `${toolLabel(event)}${status}${elapsed}。${webDetails(event)}`);
      }
    }
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
