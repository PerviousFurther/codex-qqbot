// Offline only. Use the installed SDK with a fake token and stubbed fetch.
import assert from 'node:assert/strict';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QQDelivery } from '../lib/qq-delivery.mjs';
import { QQDiagnostics } from '../lib/qq-diagnostics.mjs';
import { QQResponse } from '../lib/qq-response.mjs';

const originalFetch = globalThis.fetch;
const target = { scope: 'c2c', targetId: 'fixture', msgId: 'fixture-input' };
const file = { name: 'diagnostic-fixture.txt', text: 'metadata only' };
let phase = 'success'; let calls = []; let stages = []; let uploaded = false;
const notifications = []; const traces = [];
const bot = new QQBot({ appId: 'fixture-app', appSecret: 'fixture-secret', baseUrl: 'https://api.bot.qq.com' });
bot.tokenManager.getAccessToken = async () => 'fixture-token';
globalThis.fetch = async (input, init) => {
  const path = new URL(input).pathname; const body = JSON.parse(init.body);
  calls.push({ path, body, auth: init.headers.Authorization });
  if (path.endsWith('/files')) {
    if (phase === 'upload-failed') return Response.json({ code: 340067, message: 'Authorization登录态类型必须为QQBot' }, { status: 405 });
    uploaded = true;
    return Response.json({ file_info: 'fixture-media', file_uuid: 'fixture-upload' });
  }
  assert.equal(path, '/v2/users/fixture/messages');
  if (phase === 'send-failed') return Response.json({ code: 340067, message: 'Authorization登录态类型必须为QQBot' }, { status: 405 });
  if (phase === 'send-timeout') throw new Error('fixture transport unavailable');
  return Response.json({ id: 'fixture-message' });
};
const delivery = new QQDelivery({ bot, diagnostics: new QQDiagnostics('fixture-secret', () => {}),
  markdown: false, onState() {}, assertCanContinue: async () => {}, notifyAdmins: async event => notifications.push(event) });
const reset = next => { phase = next; calls = []; stages = []; uploaded = false; };
try {
  await delivery.send('c2c:fixture', { text: 'report', file }, { replyTarget: target, isActive: () => true, onStage: stage => stages.push(stage) });
  assert.equal(calls.length, 2); assert(calls.every(call => call.auth === 'QQBot fixture-token'));
  assert.deepEqual(calls[0].body, { file_type: 4, file_name: file.name,
    file_data: Buffer.from(file.text).toString('base64'), srv_send_msg: false });
  assert.equal(calls[1].body.msg_type, 7); assert.equal(calls[1].body.msg_id, target.msgId);
  assert.equal(calls[1].body.media.file_info, 'fixture-media');
  assert.deepEqual(stages, ['diagnostic_file_upload', 'diagnostic_file_uploaded', 'diagnostic_file_send', 'diagnostic_file_sent']);
  for (const [next, expectedStage, count] of [['upload-failed', 'file_upload', 1], ['send-failed', 'file_send', 2], ['send-timeout', 'file_send', 2]]) {
    reset(next);
    await assert.rejects(delivery.send('c2c:fixture', { text: 'report', file }, { replyTarget: target, isActive: () => true, onStage: stage => stages.push(stage) }), error => {
      assert.equal(error.diagnosticStage, expectedStage);
      assert.equal(delivery.diagnostics.errorDetails(error).kind, expectedStage);
      return true;
    });
    assert.equal(calls.length, count); // No retry, resend, or text fallback.
    assert(!stages.includes('diagnostic_file_sent'));
  }
  reset('revoked');
  await assert.rejects(delivery.send('c2c:fixture', { text: 'report', file }, { replyTarget: target, isActive: () => !uploaded }), /REPLY_TURN_EXPIRED/);
  assert.equal(calls.length, 1);
  reset('upload-failed');
  const response = new QQResponse({ message: { kind: 'c2c', senderId: 'fixture', requestId: 'fixture-request', replyTarget: target },
    delivery, debug: { record: (scope, stage, details) => traces.push({ stage, ...details }) }, onState() {} });
  assert.deepEqual(await response.send({ text: 'report', file }), { deliveryFailed: true });
  assert(traces.some(event => event.stage === 'diagnostic_file_upload'));
  assert(traces.some(event => event.stage === 'qq_failed' && event.kind === 'file_upload' && event.bizCode === 340067));
  assert(!notifications.at(-1).text.includes('发送诊断报告')); // Do not direct a failed report back to itself.
  assert.equal(calls.length, 1);
  console.log('Offline diagnostic-file checks passed: real SDK authentication/body, stage tracing, revocation and no fallback/retry.');
} finally { globalThis.fetch = originalFetch; }
