import { redactCredentials } from './policy.mjs';
import { contextTime } from './context-time.mjs';

const numeric = ['inputChars', 'outputChars', 'count', 'chars', 'elapsedMs', 'httpStatus', 'bizCode', 'rpcCode', 'attemptedCount', 'messageType', 'elementCount'];
const identifiers = ['scope', 'requestId', 'reason', 'tool', 'kind', 'eventType', 'traceId', 'agentCode'];

export function diagnosticEvents(data) {
  return [...(data.events ?? []), ...(data.model?.events ?? []), ...Object.values(data.latest ?? {}), ...(data.errors ?? [])];
}

// The human summary and raw appendix share the same metadata allowlist.
export function safeDiagnosticEvents(data = {}) {
  const events = diagnosticEvents(data).map(item => {
    const event = {};
    if (typeof item.at === 'string' && Number.isFinite(Date.parse(item.at))) event.at = item.at;
    if (typeof item.stage === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(item.stage)) event.stage = item.stage;
    for (const key of numeric) if (Number.isFinite(item[key])) event[key] = item[key];
    for (const key of identifiers) if (typeof item[key] === 'string'
      && /^[a-zA-Z0-9_:.\-]{1,160}$/.test(item[key])) event[key] = item[key];
    return event;
  });
  return [...new Map(events.map(event => [JSON.stringify(event), event])).values()]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// Export only bounded diagnostic metadata, never whole state objects or conversation records.
export function diagnosticFile({ title, summary = '', detail, data = {} }) {
  const at = new Date().toISOString();
  const timeline = safeDiagnosticEvents(data).slice(-160);
  const counters = Object.entries(data.counters ?? {}).filter(([key, value]) => /^[a-z_]{1,100}$/.test(key) && Number.isFinite(value));
  const contents = `${title}\n生成时间：${contextTime(at)} 北京时间（UTC+8）\n范围：服务、当前私聊与群聊的有限诊断快照，可能含已恢复的历史故障\n不包含聊天正文、人设正文、内部思考或登录凭据\n\n${summary ? `诊断摘要\n${summary}\n\n` : ''}完整状态快照（原始字段；历史错误不等于当前故障）\n${detail}\n\n累计计数（跨重启保留，不是本次请求统计）\n${counters.map(([key, value]) => `${key}: ${value}`).join('\n') || '暂无'}\n\n事件时间线（保留原始 ISO 时间及任务编号）\n${timeline.map(event => JSON.stringify(event)).join('\n') || '暂无'}\n`;
  return { name: `qqbot-diagnostic-${at.replace(/[-:.]/g, '')}.txt`,
    text: redactCredentials(contents) };
}
