// Offline: temporary settings and fake QQ APIs; never reads real chat bodies or sends real messages.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { scopeId } from '../lib/policy.mjs';
import { VideoController } from '../lib/controller.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';
import { QQDelivery } from '../lib/qq-delivery.mjs';
import { QQDiagnostics } from '../lib/qq-diagnostics.mjs';
import { RequestUpdates } from '../lib/request-updates.mjs';
import { webFeedbackUrls } from '../lib/web-feedback.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-feedback-'));
const store = new Store(root); let controller;
try {
  controller = new VideoController({ store, admins: ['operator'], adapter: { reset: async () => {}, close: async () => {} } });
  const scope = 'group:fixture'; const id = scopeId(scope);
  const group = { id, openid: 'fixture', allowed: true, listen: true, engage: true, progress: true, toolMonitor: false,
    push: false, name: 'Fixture', observedAt: new Date().toISOString(), pushPending: true, pushOwner: 'another-sender' };
  await store.write(controller.groupAccess.path(id), group);
  assert.equal((await controller.groupAccess.read(id)).toolMonitor, true);
  assert.equal((await controller.groupAccess.read(id)).progress, undefined);
  const sent = []; let mutation = null; let uploadMutation = null; let reject = false;
  const diagnostics = new QQDiagnostics('fixture-secret', () => {});
  const delivery = new QQDelivery({ diagnostics, markdown: false, onState() {}, assertCanContinue: async () => {},
    notifyAdmins: report => notifier.send(report), bot: {
      sendText: async (target, text) => { if (reject) throw Object.assign(new Error('rejected'), { httpStatus: 429 }); sent.push({ target, text }); return {}; },
      uploadMedia: async () => { await uploadMutation?.(); return { file_info: 'fixture' }; },
      send: async args => { sent.push(args); return {}; },
    } });
  const notifier = new AdminNotifications(controller, delivery);
  const originalSend = delivery.send.bind(delivery);
  delivery.send = async (target, text, options) => {
    const beforeSend = options?.beforeSend;
    return originalSend(target, text, { ...options, beforeSend: async () => { await mutation?.(); await beforeSend?.(); } });
  };
  const feedback = report => notifier.send({ scope, requestId: 'same-task', reason: 'TASK_FEEDBACK', text: report.text,
    feedback: true, isActive: report.isActive });
  const updates = new RequestUpdates({ toolMonitor: true }, feedback);
  updates.update({ kind: 'started' });
  for (let i = 0; i < 2; i++) updates.update({ kind: 'tool', name: 'read_webpage', arguments: 'PRIVATE_ARGUMENTS' });
  updates.update({ kind: 'tool-result', name: 'read_webpage', status: 'completed', elapsedMs: 200, result: 'PRIVATE_RESULT' });
  updates.update({ kind: 'explanation', text: 'PRIVATE_REASONING' });
  // Final structured output is not a chat-send event, including silent turns.
  updates.update({ kind: 'answer' });
  await updates.finish();
  assert.equal(sent.length, 5); // Started + two starts + result + completion, no per-task dedup.
  assert(sent.every(({ target }) => target.scope === 'c2c' && target.targetId === 'operator' && !target.msgId));
  assert(!JSON.stringify(sent).includes('PRIVATE_'));
  assert(!JSON.stringify(sent).includes('正在准备回复'));
  const noteUpdates = new RequestUpdates({ toolMonitor: true }, feedback);
  for (const [name, label] of Object.entries({ list_files: '查找笔记', read_file: '读取笔记', save_file: '保存笔记', delete_file: '删除笔记' })) {
    noteUpdates.update({ kind: 'tool', name, memoryNote: true });
    for (const status of ['completed', 'failed', 'interrupted']) noteUpdates.update({ kind: 'tool-result', name, memoryNote: true, status, elapsedMs: 100 });
    await noteUpdates.pending;
    assert(sent.at(-4).text.includes(`开始${label}`));
    assert(sent.at(-3).text.includes(`${label}已完成`));
    assert(sent.at(-2).text.includes(`${label}未能完成`));
    assert(sent.at(-1).text.includes(`${label}已中断`));
  }
  noteUpdates.update({ kind: 'tool', name: 'save_file' });
  await noteUpdates.close();
  assert(sent.at(-1).text.includes('开始保存文件'));
  const contextUpdates = new RequestUpdates({ toolMonitor: true }, feedback);
  contextUpdates.update({ kind: 'tool', name: 'list_context_chats', arguments: 'PRIVATE_DIRECTORY' });
  contextUpdates.update({ kind: 'tool-result', name: 'read_chat_context', status: 'completed', elapsedMs: 20, result: 'PRIVATE_CONTEXT' });
  await contextUpdates.close();
  assert(sent.at(-2).text.includes('查找可共享的聊天'));
  assert(sent.at(-1).text.includes('查询其他聊天上下文已完成'));
  assert(!JSON.stringify(sent).includes('PRIVATE_'));
  assert.equal((await controller.groupAccess.read(id)).pushOwner, 'another-sender');
  assert.deepEqual(webFeedbackUrls(['https://www.reddit.com/r/test?token=SECRET#PRIVATE',
    'https://user:SECRET@github.com/private', 'http://127.0.0.1/private', 'https://onlyfans.com/private',
    'https://github.com:8443/private', 'https://github.com/sk-12345678901234567890',
    'https://github.com/\nPRIVATE', 'https://not-allowed.invalid/private']), ['https://www.reddit.com/r/test']);
  const webUpdates = new RequestUpdates({ toolMonitor: true }, feedback);
  webUpdates.update({ kind: 'tool', name: 'web_open_page', urls: ['https://github.com/v2fly?SECRET=1#PRIVATE'] });
  webUpdates.update({ kind: 'tool-result', name: 'web_search', status: 'completed', elapsedMs: 100,
    urls: ['https://www.reddit.com/r/test?SECRET=1'] });
  webUpdates.update({ kind: 'tool-result', name: 'web_search', status: 'completed', urls: [] });
  await webUpdates.close();
  assert(sent.at(-3).text.includes('https://github.com/v2fly'));
  assert(sent.at(-2).text.includes('https://www.reddit.com/r/test'));
  assert(sent.at(-1).text.includes('未提供可展示的网址'));
  assert(!JSON.stringify(sent).includes('SECRET'));
  // Search feedback is independent of the project webpage acquisition allowlist.
  assert.deepEqual(webFeedbackUrls(['https://www.nasa.gov/news?q=SECRET']), ['https://www.nasa.gov/news']);
  assert(!JSON.stringify(controller.debug.read(scope)).includes('https://'));
  const report = { text: '工具：读取网页 · 开始', toolMonitor: true, isActive: () => true };
  const beforeDisabled = sent.length;
  mutation = async () => controller.groupAccess.update(id, value => { value.toolMonitor = false; });
  await feedback(report); assert.equal(sent.length, beforeDisabled);
  mutation = null;
  await feedback({ ...report, text: '开始处理新消息。' }); assert.equal(sent.length, beforeDisabled);
  await controller.groupAccess.update(id, value => { value.toolMonitor = true; });
  mutation = async () => controller.groupAccess.update(id, value => { value.taskBlocked = 'ADMIN_STOPPED'; });
  await feedback(report); assert.equal(sent.length, beforeDisabled); mutation = null;
  await controller.groupAccess.update(id, value => { delete value.taskBlocked; });
  mutation = async () => { controller.admins = []; };
  await feedback(report); assert.equal(sent.length, beforeDisabled); mutation = null; controller.admins = ['operator'];
  await feedback({ ...report, isActive: () => false }); assert.equal(sent.length, beforeDisabled);
  // No source-chat fallback or recursive report if administrator delivery fails.
  reject = true; await feedback(report); assert.equal(sent.length, beforeDisabled); reject = false;
  assert(controller.debug.read(scope).counters.admin_notification_failed >= 1);
  await notifier.send({ scope, reason: 'QQ_RATE_LIMITED', text: 'fixture platform error' });
  assert.equal(sent.at(-1).target.targetId, 'operator');
  // Private monitoring follows the same route and rechecks its setting.
  await controller.adminSettings.update('c2c:operator', value => { value.toolMonitor = true; });
  await notifier.send({ scope: 'c2c:operator', reason: 'TASK_FEEDBACK', text: '工具：读取网页 · 完成', feedback: { toolMonitor: true } });
  assert.equal(sent.at(-1).target.targetId, 'operator');
  // Ordinary group text still goes to the explicit group ID through send().
  await originalSend(scope, 'actual answer'); assert.equal(sent.at(-1).target.scope, 'group');
  await assert.rejects(originalSend(scope, 'wrong reference', { replyTarget: { scope: 'c2c', targetId: 'operator' } }), /REPLY_TARGET_MISMATCH/);
  // Media rechecks the same guard after upload and preserves its caption.
  let enabled = true; const beforeMedia = sent.length;
  uploadMutation = async () => { enabled = false; };
  await assert.rejects(originalSend(scope, { text: '[title](https://example.com)', media: { type: 'image', bytes: Buffer.from('x'), assertAccess: async () => {} } }, {
    beforeSend: async () => { if (!enabled) throw new Error('ACCESS_REVOKED'); },
  }), /ACCESS_REVOKED/);
  assert.equal(sent.length, beforeMedia);
  enabled = true; uploadMutation = null;
  await originalSend(scope, { text: '[title](https://example.com)', media: { type: 'image', bytes: Buffer.from('x'), assertAccess: async () => {} } });
  assert.equal(sent.at(-1).content, '[title](https://example.com)');
  // Upstream errors bypass the optional monitor and expose classification only.
  await controller.groupAccess.update(id, value => { value.toolMonitor = false; });
  const beforeModelError = sent.length;
  await notifier.send({ scope, requestId: 'upstream-fixture', reason: 'CODEX_UPSTREAM_ERROR', agentCode: 'httpConnectionFailed' });
  assert.equal(sent.length, beforeModelError + 1);
  assert(sent.at(-1).text.includes('模型服务连接异常'));
  await notifier.send({ scope, requestId: 'upstream-fixture', reason: 'CODEX_UPSTREAM_ERROR', agentCode: 'httpConnectionFailed' });
  assert.equal(sent.length, beforeModelError + 1);
  console.log('Offline feedback checks passed: one conversation-ID sender, admin-only hints/errors, live opt-out/stop/revocation, no source fallback, independent replies and post-upload guards.');
} finally { await controller?.close(); await rm(root, { recursive: true, force: true }); }
