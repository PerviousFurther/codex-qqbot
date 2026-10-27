// Offline fixtures only: temporary files, saved-image database and fake QQ transport.
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { VideoController } from '../lib/controller.mjs';
import { WorkspaceFiles } from '../lib/workspace-files.mjs';
import { MemoryFiles } from '../lib/memory-files.mjs';
import { QQResponse } from '../lib/qq-response.mjs';
import { QQDelivery } from '../lib/qq-delivery.mjs';
import { QQDiagnostics } from '../lib/qq-diagnostics.mjs';
import { commandKeyboard } from '../lib/qq-ui.mjs';
import { scopeId } from '../lib/policy.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-file-management-'));
const store = new Store(root); let controller;
try {
  controller = new VideoController({ store, admins: ['operator'], adapter: { close: async () => {} } });
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: true });
  const admin = 'c2c:operator'; const group = 'group:fixture'; const groupId = scopeId(group);
  await store.write(controller.groupAccess.path(groupId), { id: groupId, openid: 'fixture', allowed: true, listen: true });
  const workspace = new WorkspaceFiles(store, admin); const shared = new MemoryFiles(store, admin);
  const groupFiles = new WorkspaceFiles(store, group);
  const body = '完整文本😀\n'.repeat(700);
  await workspace.write('中文文件.md', body);
  for (let i = 0; i < 70; i++) await workspace.write(`note-${i}.txt`, 'small note');
  assert.equal((await workspace.list()).files.length, 71);
  assert.equal((await workspace.list()).max_files, undefined);
  assert.throws(() => workspace.write('oversize.txt', 'x'.repeat(65537)), /WORKSPACE_FILE_TOO_LARGE/);
  await shared.write('knowledge.md', 'shared public note');
  await groupFiles.write('group.txt', 'GROUP_CONTENT');
  const handle = text => controller.fileManagement.handle(admin, text);
  const buttons = response => response.buttons.rows.flat();
  const select = (response, text) => buttons(response).find(button => button.label === text).command;
  await assert.rejects(controller.fileManagement.handle('c2c:other', '/files'), /ADMIN_ACCESS_REQUIRED/);
  let denied;
  await controller.commands.dispatch({ who: { scope: group, admin: true, private: false }, text: '/files shared', reply: async value => { denied = value; } });
  assert.equal(typeof denied, 'string'); assert(!denied.includes('shared public note'));
  const groupList = await handle(`/files ${groupId}`);
  let groupView = await handle(select(groupList, 'group.txt'));
  assert(groupView.text.includes('GROUP_CONTENT'));
  const groupExport = await handle(select(groupView, '导出完整 TXT'));
  const sharedList = await handle('/files shared');
  assert(select(sharedList, 'knowledge.md'));
  const guide = await handle(select(sharedList, 'AGENTS.md'));
  assert(!buttons(guide).some(button => button.label === '删除文件'));
  assert.throws(() => shared.remove('AGENTS.md', ''), /MEMORY_GUIDE_READ_ONLY/);
  let list = await handle('/files current'); let found; const visited = [];
  do {
    commandKeyboard(list.buttons);
    visited.push(...buttons(list).filter(button => button.command.includes(' view ')).map(button => button.label));
    found ??= buttons(list).find(button => button.label === '中文文件.md')?.command;
    const next = buttons(list).find(button => button.label === '下一页');
    list = next ? await handle(next.command) : null;
  } while (list);
  assert.equal(new Set(visited).size, 71); assert(found);
  let view = await handle(found); let reconstructed = '';
  do {
    commandKeyboard(view.buttons);
    reconstructed += view.text.split('\n\n').slice(1).join('\n\n');
    const next = buttons(view).find(button => button.label === '下一页');
    view = next ? await handle(next.command) : null;
  } while (view);
  assert.equal(reconstructed, body);
  view = await handle(found);
  const exported = await handle(select(view, '导出完整 TXT'));
  assert.equal(exported.file.text, body); await exported.file.assertAccess();
  const originalGroupFile = groupExport.file;
  await controller.groupAccess.update(groupId, item => { item.allowed = false; });
  await assert.rejects(originalGroupFile.assertAccess(), /GROUP_NOT_AUTHORIZED/);
  assert(!(await handle(`/files ${groupId}`)).text.includes('GROUP_CONTENT'));
  await controller.groupAccess.update(groupId, item => { item.allowed = true; });

  // Confirmation binds the current file contents and administrator; replacement is never silently erased.
  const pending = await handle(select(view, '删除文件'));
  await workspace.write('中文文件.md', 'updated note', true);
  assert((await handle(select(pending, '确认删除'))).text.includes('未删除'));
  assert.equal(await workspace.readText('中文文件.md'), 'updated note');
  const pendingAgain = await handle(select(await handle(found), '删除文件'));
  await handle(select(pendingAgain, '确认删除'));
  await assert.rejects(workspace.readText('中文文件.md'), /ENOENT/);
  await assert.rejects(exported.file.assertAccess(), /ENOENT/);
  await symlink('/not/a/real/private/file', join(root, 'workspace', scopeId(admin), 'link.txt'));
  await assert.rejects(workspace.readText('link.txt'));

  // Saved images no longer evict by count or aggregate bytes.
  const pixels = Buffer.from([255, 216, 255, 0]); let first;
  for (let i = 0; i < 260; i++) {
    const saved = await controller.savedImages.save(admin, pixels, { label: String(i), source: { kind: 'public_image', url: 'https://github.com/fixture.jpg' }, shareable: true });
    first ??= saved.asset_id;
  }
  assert.equal((await controller.savedImages.list(admin)).length, 260);
  assert.deepEqual((await controller.savedImages.get(admin, first)).bytes, pixels);
  const large = Buffer.alloc(12 * 1024 * 1024); pixels.copy(large);
  for (let i = 0; i < 3; i++) await controller.savedImages.save(admin, large, { label: 'large fixture', source: { kind: 'public_image' } });
  assert.equal((await controller.savedImages.list(admin)).length, 263);

  // Media management never publishes private download URLs or opens another private chat.
  const media = text => controller.mediaManagement.handle(admin, text);
  const messages = [
    { messageId: 'image', filename: 'fixture.jpg', content_type: 'image/jpeg', bytes: pixels },
    { messageId: 'video', filename: 'fixture.mp4', content_type: 'video/mp4', bytes: Buffer.from('0000ftypmp42') },
    { messageId: 'audio', filename: 'fixture.mp3', content_type: 'audio/mpeg', bytes: Buffer.from('ID3fixture') },
    { messageId: 'text', filename: 'fixture.txt', content_type: 'file', bytes: Buffer.from('received text') },
  ];
  const payloads = new Map(messages.map(message => [`https://multimedia.nt.qq.com.cn/${message.messageId}?rkey=PRIVATE_SENTINEL`, message.bytes]));
  controller.mediaManagement.download = async (url, limit) => { const bytes = payloads.get(url); assert(bytes.length <= limit); return bytes; };
  for (const item of messages) await controller.messageRecords.capture(group, {
    kind: 'group', groupOpenid: 'fixture', messageId: item.messageId, senderId: 'member', content: '',
    attachments: [{ filename: item.filename, content_type: item.content_type, size: item.bytes.length, url: [...payloads.keys()].find(url => url.includes(`/${item.messageId}?`)) }],
  }, null, true);
  const receivedList = await media(`/media ${groupId} received`);
  commandKeyboard(receivedList.buttons);
  assert(!JSON.stringify(receivedList).includes('PRIVATE_SENTINEL'));
  let receivedImage; let pointerId;
  for (const item of messages) {
    const detail = await media(select(receivedList, item.filename));
    const opened = await media(select(detail, item.messageId === 'text' ? '查看文本' : '在私聊打开'));
    if (item.messageId === 'text') {
      assert(opened.text.includes('received text'));
      const exportedText = await media(select(opened, '导出完整 TXT'));
      assert.equal(exportedText.file.text, 'received text'); await exportedText.file.assertAccess();
    }
    else { assert.equal(opened.media.type, item.messageId); await opened.media.assertAccess(); }
    if (item.messageId === 'image') { receivedImage = opened; pointerId = select(detail, '在私聊打开').split(' ').at(-1); }
    assert(!JSON.stringify(opened).includes('PRIVATE_SENTINEL'));
  }
  const pointer = await controller.messageRecords.attachmentDetail(group, pointerId);
  assert(pointer.attachment.imageId);
  const deleteMedia = await media(select(await media(select(receivedList, 'fixture.jpg')), '删除'));
  await media(select(deleteMedia, '确认删除'));
  assert.equal(await controller.messageRecords.attachment(group, pointerId), null);
  await assert.rejects(receivedImage.media.assertAccess(), /ATTACHMENT_NOT_RETAINED/);
  assert.equal((await controller.messageImages.database(group)).prepare('SELECT COUNT(*) AS count FROM images WHERE id=?').get(pointer.attachment.imageId).count, 0);
  const savedList = await media('/media current saved');
  const savedView = await media(select(savedList, 'large fixture'));
  const savedOpen = await media(select(savedView, '在私聊打开'));
  assert.equal(savedOpen.media.type, 'image'); await savedOpen.media.assertAccess();
  const savedDelete = await media(select(savedView, '删除'));
  await media(select(savedDelete, '确认删除'));
  await assert.rejects(savedOpen.media.assertAccess(), /SAVED_IMAGE_NOT_RETAINED/);
  await controller.groupAccess.update(groupId, item => { item.allowed = false; });
  assert((await media(`/media ${groupId} received`)).text.includes('未获授权'));
  await controller.groupAccess.update(groupId, item => { item.allowed = true; });
  await assert.rejects(controller.mediaManagement.handle('c2c:other', '/media current'), /ADMIN_ACCESS_REQUIRED/);

  // Export uses the existing upload/message/button path. Revocation after upload blocks publication.
  const outgoing = []; let revoke = false;
  const delivery = new QQDelivery({ bot: {
    api: { post: async (_path, data) => { outgoing.push({ upload: data }); if (revoke) controller.admins = []; return { file_info: 'fixture' }; } },
    uploadMedia: async value => { outgoing.push({ mediaUpload: value }); if (revoke) controller.admins = []; return { file_info: 'fixture-media' }; },
    send: async value => { outgoing.push(value); return {}; },
    sendText: async (_target, text, options) => { outgoing.push({ text, options }); return {}; },
  }, diagnostics: new QQDiagnostics('fixture', () => {}), markdown: false, onState() {}, assertCanContinue: async () => {}, notifyAdmins: async () => {} });
  const file = (await handle(select(groupView, '导出完整 TXT'))).file;
  const response = new QQResponse({ message: { kind: 'c2c', senderId: 'operator', replyTarget: { scope: 'c2c', targetId: 'operator', msgId: 'fixture' } }, delivery, debug: { record() {} }, onState() {} });
  await response.send({ text: '完整 TXT', file, buttons: { rows: [[{ label: '返回', command: '/files' }]] } });
  assert.equal(Buffer.from(outgoing[0].upload.file_data, 'base64').toString(), 'GROUP_CONTENT');
  assert.equal(outgoing[1].msgType, 7); assert(outgoing[2].text.includes('/files'));
  const videoDetail = await media(select(await media(`/media ${groupId} received`), 'fixture.mp4'));
  const videoOpen = await media(select(videoDetail, '在私聊打开'));
  await delivery.send(admin, { media: videoOpen.media });
  assert.equal(outgoing[3].mediaUpload.fileType, 2); assert.equal(outgoing[3].mediaUpload.srvSendMsg, false);
  assert.equal(outgoing[4].msgType, 7);
  revoke = true;
  await assert.rejects(delivery.send(admin, { media: videoOpen.media }), /ADMIN_ACCESS_REVOKED/);
  assert.equal(outgoing.length, 6); // Revocation after media upload prevents message submission.
  controller.admins = ['operator'];
  await assert.rejects(delivery.send(admin, { file }), /ADMIN_ACCESS_REVOKED/);
  assert.equal(outgoing.length, 7); // The rejected call uploaded only, without a message submission.
  console.log('Offline file-management checks passed: private admin access, scope isolation, pagination/full TXT, protected guide, confirmed deletion, unlimited file/image counts, scoped media viewing/deletion and export upload revocation.');
} finally { await controller?.close(); await rm(root, { recursive: true, force: true }); }
