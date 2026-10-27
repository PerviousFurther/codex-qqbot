import { contextTime } from './context-time.mjs';
import { safeDiagnosticEvents } from './diagnostic-file.mjs';

const fixes = {
  AUDIO_LOCAL_NOT_CONFIGURED: '本地语音识别未配置模型路径，尚未进入下载/推理。设置 WATCH_AUDIO_MODEL_DIR 和 WATCH_AUDIO_VAD_MODEL；仅构建镜像不会安装模型或填写路径。QQ 已投递的转写可由 method=qq 单独读取。',
  AUDIO_RUNTIME_UNAVAILABLE: '本地识别运行库不可加载。检查镜像是否以 WATCH_AUDIO_RUNTIME=true 构建，或 WATCH_AUDIO_RUNTIME_DIR 是否指向正确的运行库安装目录。',
  AUDIO_SILK_RUNTIME_UNAVAILABLE: '缺少或无法加载 SILK 解码运行库；检查可选 audio-runtime 安装。',
  AUDIO_MODEL_UNAVAILABLE: '进程无法访问所需模型文件。检查容器内模型文件是否完整，以及运行用户的读取权限。',
  AUDIO_FFMPEG_UNAVAILABLE: '找不到 ffmpeg；检查是否使用包含音频运行依赖的镜像。',
  AUDIO_DECODER_BUSY: '已有本地识别任务占用共享名额；本次没有再加载模型。稍后再试，不自动并发。',
  AUDIO_TIMEOUT: '音频处理超过时限；需实测模型加载和识别耗时，不能仅凭超时判断网络或内存故障。',
  AUDIO_WORKER_FAILED: '音频子进程异常退出；本报告未记录退出原因，不能直接认定为内存不足。',
  AUDIO_TOO_LARGE: '附件超过本地识别的 8 MiB 上限，需要缩小文件。',
  AUDIO_DURATION_LIMIT: '音频超过该入口的时长上限，需要提供较短片段。',
  AUDIO_FORMAT_UNSUPPORTED: '音频格式无法解码；需核实实际收到的格式，不能凭附件名认定支持。',
  AUDIO_URL_NOT_PROVIDED: 'QQ 未提供可下载的音频地址；无法从缺失地址恢复音频。',
  AUDIO_TRANSCRIPT_TOO_LARGE: '转写结果超过返回预算，本次未返回部分结果冒充完整转写。',
  ATTACHMENT_NOT_RETAINED: '该附件不在当前会话保留范围内，可能已过期或清理。',
  GROUP_MESSAGES_DISABLED: '当前群权限或历史采集权限不满足读取条件；不能通过其他工具绕过。',
  COMPACTION_REQUIRES_UNFILTERED_PREFIX: '模型请求压缩时使用了筛选条件。应完整读取待压缩前缀后再压缩，不需要重登账号。',
  BILIBILI_QR_URL_ORIGIN_INVALID: 'B站二维码地址未通过来源校验；这是登录入口问题，与语音模型配置无关。',
  IMAGE_TOO_LARGE: '图片超过 16 MiB 上限，需要压缩或降低分辨率后重发。',
};
const failed = event => /failed|error/.test(event.stage ?? '') || event.stage === 'mcp_auth_required';
const time = event => event?.at ? contextTime(event.at) : '时间未保留';

// Only fixed interpretations of allowlisted metadata. Never ask another model to
// summarize logs or treat a later reply as proof that a failed operation worked.
export function diagnosticSummary({ events, groups = [], currentScope, closed = false, audio = {}, current = {} }) {
  const all = safeDiagnosticEvents({ events });
  const labels = new Map([[currentScope, '当前私聊'], ...groups.map(group => [group.scope, `群 ${group.name}`])]);
  const label = event => labels.get(event.scope) ?? `范围 ${event.scope ?? '未知'}`;
  const latestFailure = all.findLast(event => event.scope === currentScope && failed(event));
  const lines = [`服务主进程：${closed ? '已关闭' : '运行中'}；这不等于所有功能均已就绪。`];
  const state = { idle: '空闲', paused: '暂停', responding: '正在回应', browsing: '后台浏览中', error: '错误状态' }[current.state] ?? '状态未提供';
  lines.push(`当前私聊：${state}；等待任务 ${Number.isInteger(current.pending) ? current.pending : '未知'}。`);
  if (latestFailure) {
    lines.push(`当前私聊最近失败：${time(latestFailure)} ${latestFailure.tool ?? latestFailure.stage} → ${latestFailure.reason ?? '原因码未保留'}${Number.isFinite(latestFailure.elapsedMs) ? `（${latestFailure.elapsedMs} ms）` : ''}`);
    lines.push(`排查方向：${fixes[latestFailure.reason] ?? '结合下方同任务阶段和错误码定位；现有记录不足以确定根因。'}`);
  } else lines.push('当前私聊：保留事件中没有失败记录；不据此保证全部功能正常。');
  lines.push('', '当前能力配置（只读取配置，不加载模型、不访问平台）',
    `本地音频：${audio.model && audio.vad ? '两个模型路径均已填写' : '未就绪：缺少模型路径配置'}`,
    `  WATCH_AUDIO_MODEL_DIR：${audio.model ? '已填写' : '未填写'}；WATCH_AUDIO_VAD_MODEL：${audio.vad ? '已填写' : '未填写'}`,
    '  运行库可加载性、模型文件完整性、ffmpeg、CPU速度和内存是否足够：本报告未检测。',
    '  QQ转写：仅能读取QQ已投递的参考文本；不表示QQ一定为每条语音提供转写。');

  lines.push('', '群任务现状（人工停止与历史发送失败分开显示）');
  if (!groups.length) lines.push('没有纳入报告的群。');
  for (const group of groups) {
    lines.push(`${group.name}：${group.blocked === 'ADMIN_STOPPED' ? '管理员已停止'
      : group.blocked ? `任务阻塞 ${group.blocked}` : group.allowed ? '无已保存的任务阻塞' : '未授权'}；待处理 ${group.pending ?? 0}`);
    lines.push(`  采集 ${group.listen ? '开' : '关'} / 自然接话 ${group.engage ? '开' : '关'} / 视频推送 ${group.push ? '开' : '关'}；旧发送错误 ${group.oldSendError ? '有（见状态快照，时间/是否恢复需结合事件）' : '无'}`);
  }

  // Correlate by both scope and requestId: identical IDs in different scopes do
  // not combine private/group activity. Missing retained stages remain unknown.
  const requests = new Map();
  for (const event of all) {
    if (!event.requestId) continue;
    const key = `${event.scope}\0${event.requestId}`;
    if (!requests.has(key)) requests.set(key, []);
    requests.get(key).push(event);
  }
  const recent = [...requests.values()].filter(items => items.some(event =>
    /^(?:model_|mcp_|task_failed|group_reply_finished)/.test(event.stage ?? '')))
    .sort((a, b) => String(b.at(-1).at).localeCompare(String(a.at(-1).at))).slice(0, 8);
  lines.push('', '最近请求（最多8个；仅根据保留事件，缺失阶段不推断）');
  if (!recent.length) lines.push('没有可关联的模型/工具请求。');
  for (const items of recent) {
    const last = items.at(-1);
    const has = stage => items.some(event => event.stage === stage);
    const tools = items.filter(event => /^mcp_(?:started|completed|failed|auth_required)$/.test(event.stage ?? ''));
    const latestTools = new Map();
    for (const event of tools) latestTools.set(event.tool ?? '未知工具', event);
    lines.push(`${time(last)} ${label(last)}；任务 ${last.requestId}`);
    lines.push(`  模型：${has('model_final') ? '已产出最终结果' : has('model_accepted') ? '已接受请求' : has('model_submitted') ? '已提交' : '阶段未保留'}；发送：${has('qq_failed') || has('group_push_failed') ? '有失败记录' : has('qq_accepted') || has('group_push_sent') ? 'QQ已接受（不代表工具操作成功）' : '未保留成功发送记录'}`);
    for (const event of latestTools.values()) lines.push(`  工具 ${event.tool ?? '未知'}：${event.stage === 'mcp_completed' ? '成功' : failed(event) ? `失败 ${event.reason ?? '原因码未保留'}` : '已开始，未保留结束事件'}${Number.isFinite(event.elapsedMs) ? `，${event.elapsedMs} ms` : ''}`);
    if (has('group_reply_decision') && items.some(event => event.reason === 'MODEL_SILENT')) lines.push('  模型选择不发言；不等于消息未送达模型。');
  }

  lines.push('', '最近失败记录（最多6类；不是当前故障清单）');
  const failures = new Map();
  for (const event of all.filter(failed)) failures.set(`${event.scope}\0${event.tool ?? event.stage}\0${event.reason}`, event);
  const latest = [...failures.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
  if (!latest.length) lines.push('保留事件中没有失败记录。');
  for (const event of latest) {
    const later = event.tool && all.findLast(next => next.scope === event.scope && next.tool === event.tool && next.stage === 'mcp_completed' && next.at > event.at);
    lines.push(`${time(event)} ${label(event)}：${event.tool ?? event.stage} / ${event.reason ?? '原因码未保留'}`);
    lines.push(`  ${later ? `此后该工具有成功调用（${time(later)}），不证明同一操作已修复。` : '未保留可证明该失败操作恢复的记录。'}${fixes[event.reason] ?? ''}`);
  }
  const disconnect = all.findLast(event => event.stage === 'disconnected');
  if (disconnect) {
    const reconnect = all.find(event => event.scope === disconnect.scope && event.stage === 'connected' && event.at > disconnect.at);
    lines.push('', `连接：最近断开 ${time(disconnect)}；${reconnect ? `${Math.round((Date.parse(reconnect.at) - Date.parse(disconnect.at)) / 1000)} 秒后记录到重新连接` : '未保留之后的重新连接事件'}。`,
      '断开原因未保留；不能仅凭定时重连判断是否正常，也不能认定与音频错误有关。');
  }
  lines.push('', '以下附录保留技术字段与原始事件。累计数字跨重启保留，事件窗口有限；开始/结束计数差不能直接作为当前失败数。');
  return lines.join('\n');
}
