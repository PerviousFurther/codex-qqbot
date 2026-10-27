// Synthetic diagnostic metadata only: no chat state, model, QQ or file probes.
import assert from 'node:assert/strict';
import { diagnosticSummary } from '../lib/diagnostic-summary.mjs';
import { diagnosticFile } from '../lib/diagnostic-file.mjs';

const scope = 'a'.repeat(32), groupScope = 'b'.repeat(32), system = 'c'.repeat(32);
const event = (at, stage, extra = {}) => ({ at: `2026-10-26T03:${at}Z`, stage, scope, ...extra });
const events = [
  event('34:20', 'model_accepted', { requestId: 'audio-request' }),
  event('34:23', 'mcp_failed', { requestId: 'audio-request', tool: 'get_audio_detail',
    reason: 'AUDIO_LOCAL_NOT_CONFIGURED', elapsedMs: 9, body: 'CHAT_BODY_SENTINEL', arbitrary: 'SECRET_SENTINEL' }),
  event('34:25', 'model_final', { requestId: 'audio-request' }),
  event('34:26', 'qq_accepted', { requestId: 'audio-request', count: 1 }),
  // Same requestId in another scope must not turn this into a successful read.
  event('34:27', 'mcp_completed', { scope: groupScope, requestId: 'audio-request', tool: 'get_audio_detail' }),
  event('35:00', 'disconnected', { scope: system }),
  event('35:03', 'connected', { scope: system }),
  event('36:00', 'connected', { scope: system }),
];
const options = { events: [...events, events[1]], currentScope: scope,
  groups: [{ scope: groupScope, name: 'Fixture group', blocked: 'ADMIN_STOPPED',
    allowed: true, listen: true, engage: true, push: false, oldSendError: true }], audio: {} };
const summary = diagnosticSummary(options);
assert(summary.includes('AUDIO_LOCAL_NOT_CONFIGURED（9 ms）'));
assert(summary.includes('尚未进入下载/推理'));
assert(summary.includes('WATCH_AUDIO_MODEL_DIR：未填写'));
assert(summary.includes('管理员已停止'));
assert(summary.includes('QQ已接受（不代表工具操作成功）'));
assert(summary.includes('3 秒后记录到重新连接'));
assert(!summary.includes('此后该工具有成功调用'));
assert(!summary.includes('CHAT_BODY_SENTINEL'));
assert(!summary.includes('SECRET_SENTINEL'));
const recovered = diagnosticSummary({ ...options, audio: { model: true, vad: true }, events: [
  ...events, event('36:30', 'mcp_completed', { requestId: 'next-audio-request', tool: 'get_audio_detail' }),
] });
assert(recovered.includes('两个模型路径均已填写'));
assert(recovered.includes('此后该工具有成功调用'));
assert(recovered.includes('不证明同一操作已修复'));
assert(recovered.includes('本报告未检测'));
const report = diagnosticFile({ title: 'Fixture report', detail: 'service: running', summary,
  data: { events: [...events, events[1]], counters: { mcp_failed: 1 } } });
assert(report.text.indexOf('诊断摘要') < report.text.indexOf('完整状态快照'));
assert(report.text.includes('跨重启保留'));
assert(!/CHAT_BODY_SENTINEL|SECRET_SENTINEL/.test(report.text));
const raw = report.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
assert.equal(raw.length, events.length);
assert(!diagnosticSummary({ events: [], currentScope: scope }).includes('undefined'));
console.log('Diagnostic summary: synthetic correlation, recovery uncertainty, configuration, privacy and appendix checks passed.');
