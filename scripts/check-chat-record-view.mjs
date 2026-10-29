// Offline operator UI checks: synthetic messages and temporary SQLite only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';
import { ChatResponse } from '../lib/chat-response.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-chat-record-view-'));
const c = new VideoController({ store: new Store(root), admins: ['operator'], adapter: { close: async () => {} } });
const admin = 'c2c:operator'; const scope = 'group:fixture'; const groupId = scopeId(scope);
const group = { id: groupId, openid: 'fixture', allowed: true, listen: true };
const buttons = response => response.buttons.rows.flat();
const select = (response, label) => buttons(response).find(button => button.label === label).command;
const handle = text => c.conversationMaintenance.handle(admin, text);
const capture = (scope, id, content, extra = {}) => c.messageRecords.capture(scope, {
  kind: scope.startsWith('group:') ? 'group' : 'c2c', messageId: id, senderId: 'sender', senderName: '测试成员',
  timestamp: new Date().toISOString(), content, ...extra,
}, false, scope.startsWith('group:'));
try {
  await c.store.write(c.groupAccess.path(groupId), group);
  await capture(admin, 'own', 'CURRENT_PRIVATE');
  await capture('c2c:other', 'other', 'OTHER_PRIVATE');
  for (let i = 0; i < 9; i++) await capture(scope, `incoming-${i}`, `GROUP_BODY_${i}`);
  await capture(scope, 'forwarded', '', { msgType: 102, msgElements: [{ content: 'INNER_BODY' }] });
  const home = await handle(`/group-memory ${groupId}`);
  const list = await handle(select(home, '查看已保留消息'));
  assert(list.text.includes('共 10 条')); assert(!/INNER[ _]BODY/.test(list.text));
  assert(list.buttons.rows.length <= 5);
  const next = await handle(select(list, '下一页'));
  assert(next.text.includes('第 2/2 页')); assert(!/OTHER[ _]PRIVATE/.test(next.text));
  const detail = await handle(select(next, '查看第 9 条'));
  assert(detail.text.includes('GROUP_BODY'));
  const exportCommand = select(detail, '导出本条 TXT');
  const exported = await handle(exportCommand);
  assert(exported.file.text.includes('GROUP_BODY')); await exported.file.assertAccess();
  const own = await handle('/memory list');
  assert(own.text.includes('CURRENT PRIVATE')); assert(!/OTHER[ _]PRIVATE/.test(own.text)); assert(!/GROUP[ _]BODY/.test(own.text));
  const otherId = Buffer.from('other').toString('base64url');
  assert((await handle(`/memory view ${otherId}`)).text.includes('不存在'));
  await assert.rejects(c.conversationMaintenance.handle('c2c:other', '/memory list'), /ADMIN_ACCESS_REQUIRED/);
  let denied;
  await c.commands.dispatch({ who: { scope, admin: true, private: false }, text: '/memory list', reply: async value => { denied = value; } });
  assert.equal(typeof denied, 'string');
  const longBody = '字'.repeat(1050) + '😀'.repeat(60);
  const long = await capture(admin, 'long', longBody);
  const longDetail = await handle(`/memory view ${Buffer.from(long.messageId).toString('base64url')}`);
  assert(select(longDetail, '下一页'));
  assert((await handle(select(longDetail, '导出本条 TXT'))).file.text.includes(longBody));
  c.admins = []; await assert.rejects(exported.file.assertAccess(), /ADMIN_ACCESS_REVOKED/); c.admins = ['operator'];
  await c.store.write(c.groupAccess.path(groupId), { ...group, allowed: false });
  await assert.rejects(exported.file.assertAccess(), /GROUP_MESSAGES_DISABLED/);
  await c.store.write(c.groupAccess.path(groupId), group);
  await c.messageRecords.clear(scope);
  await assert.rejects(exported.file.assertAccess(), /MESSAGE_NOT_RETAINED/);
  assert((await handle(`/group-memory ${groupId} list`)).text.includes('暂时没有'));
  // Command/backend failures retain metadata without requiring any model/tool signal.
  const response = new ChatResponse({ message: { kind: 'c2c', senderId: 'operator', requestId: 'fixture-request' },
    debug: c.debug, onState() {}, delivery: { diagnostics: { errorDetails: () => ({ httpStatus: 500 }) }, reportFailure: async () => {} } });
  await response.handlerFailed(new Error('private body must not appear'));
  const event = c.debug.read(admin).events.find(item => item.stage === 'message_handler_failed');
  assert.equal(event.reason, 'MESSAGE_HANDLER_FAILED'); assert.equal(event.requestId, 'fixture-request');
  assert(!JSON.stringify(event).includes('private body'));
  console.log('Offline chat-record UI checks passed: scoped incoming lists, paging, shallow body view, TXT export, administrator/group revocation and cleared-source guards.');
} finally { await c.close(); await rm(root, { recursive: true, force: true }); }
