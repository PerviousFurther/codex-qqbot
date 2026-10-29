// Offline: temporary metadata, fake model and routed/current-chat transports.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { scopeId } from '../lib/policy.mjs';
import { VideoController } from '../lib/controller.mjs';
import { ReplyBridge } from '../lib/reply-bridge.mjs';
import { assertDeliveryAccess, assertReplyAccess } from '../lib/reply-access.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-routing-check-'));
const store = new Store(root); let controller; let phase = 'broadcast'; let checked = [];
const groups = ['source', 'one', 'two', 'denied', 'disabled', 'paused', 'busy'];
const groupAlias = name => `group:${scopeId(`group:${name}`)}`;
const privateAlias = name => `private:${scopeId(`c2c:${name}`)}`;
const privateMessage = (senderId, senderName = '') => ({ kind: 'c2c', senderId, senderName, messageId: `fixture-${senderId}`, content: 'hello' });
let sent = []; let current = []; let mutation = null; let failTarget = null;
const adapter = { reset: async () => {}, close: async () => {}, run: async options => {
  const ids = options.replyTargets.map(target => target.id);
  if (phase === 'warmup') {
    assert.deepEqual(ids, ['current']); await assert.rejects(options.onReply('no', groupAlias('one')), /REPLY_TARGET_NOT_ALLOWED/);
    checked.push(phase); return { sharedState: null };
  }
  assert(ids.includes(groupAlias('one'))); assert(ids.includes(groupAlias('two')));
  assert(ids.includes('admin:1')); assert(ids.includes(privateAlias('person')));
  assert(!ids.includes(groupAlias('source'))); // The source is represented only as current.
  for (const name of ['denied', 'disabled', 'paused', 'busy']) assert(!ids.includes(groupAlias(name)));
  const bridge = new ReplyBridge(); const binding = bridge.bind({ id: 'fixture', send: options.onReply });
  const part = (part_id, target, text = 'same public announcement', media) => bridge.dispatch({ turn_id: 'fixture', part_id, target, text, media });
  if (phase === 'broadcast') {
    await part(1, groupAlias('one')); await part(2, groupAlias('two')); await part(3, privateAlias('person'));
    assert.equal(binding.turn.answerSent, 0); assert.equal(binding.turn.routedSent, 3);
    // Routed sends do not count as current-chat sends.
  } else if (phase === 'partial-failure') {
    await part(1, groupAlias('one'));
    await assert.rejects(part(2, groupAlias('two')), /FIXTURE_SEND_FAILED/);
    assert.equal(binding.turn.failed, true);
    await assert.rejects(part(3, privateAlias('person')), /REPLY_TURN_EXPIRED/);
  } else if (phase === 'target-revoked') {
    await assert.rejects(part(1, groupAlias('one')), /GROUP_NOT_AUTHORIZED/);
  } else if (phase === 'private-disabled') {
    await part(1, privateAlias('person'));
    await part(2, 'admin:1');
  } else if (phase === 'media') {
    await part(1, groupAlias('one'), `![public](asset://${publicAsset.asset_id})`);
    await assert.rejects(part(2, groupAlias('two'), `![private](asset://${chatAsset.asset_id})`), /CROSS_CONVERSATION_ASSET_DISABLED/);
  }
  const result = { sharedState: null,
    replyAnswerSent: binding.turn.answerSent, replyRoutedSent: binding.turn.routedSent, replyDeliveryFailed: binding.turn.failed };
  binding.close(); checked.push(phase); return result;
} };
let publicAsset; let chatAsset;
try {
  controller = new VideoController({ adapter, store, admins: ['operator'] });
  for (const name of groups) {
    const group = { id: scopeId(`group:${name}`), openid: name, name: `Group ${name}`, allowed: name !== 'denied',
      listen: true, engage: true, push: !['source', 'disabled'].includes(name), observedAt: new Date().toISOString(), schedule: { warmup: true } };
    if (name === 'paused') group.taskBlocked = 'ADMIN_STOPPED';
    if (name === 'busy') { group.pushPending = true; group.pushOwner = 'other'; }
    await store.write(controller.groupAccess.path(group.id), group);
  }
  await controller.replyContacts.observe(privateMessage('person', 'Recipient'));
  await controller.replyContacts.observe(privateMessage('other-person', 'Other'));
  const pixels = Buffer.from([255, 216, 255, 0]);
  publicAsset = await controller.savedImages.save('group:source', pixels, { label: 'public', source: { kind: 'public_image', url: 'https://github.com/fixture.jpg' }, shareable: true });
  chatAsset = await controller.savedImages.save('group:source', pixels, { label: 'private chat picture', source: { kind: 'qq_group_image', imageId: 'a'.repeat(32), historical: false } });
  controller.sendRoutedReply = async (target, text, active, beforeSend, media, beforeCommit) => {
    await beforeSend(); await mutation?.(target); await media?.assertAccess(); await beforeCommit();
    await assertDeliveryAccess(target, controller, active);
    if (target === failTarget) throw new Error('FIXTURE_SEND_FAILED');
    sent.push({ target, text, media: !!media });
  };
  const reset = async next => {
    phase = next; sent = []; current = []; mutation = null; failTarget = null;
    await store.write(join(root, 'chat-access.json'), { publicPrivateChat: true });
    await controller.replyContacts.observe(privateMessage('person', 'Recipient'));
    for (const name of ['one', 'two']) await controller.groupAccess.update(scopeId(`group:${name}`), group => {
      group.allowed = true; group.push = true; delete group.taskBlocked; delete group.pushPending; delete group.pushOwner; delete group.nextMessageAt;
    });
  };
  const run = purpose => controller.run('group:source', 'fixture signal', {}, { background: true, purpose, onReply: async text => current.push(text) });
  const result = await run('batch');
  assert.equal(result.replyRoutedSent, 3); assert.equal(result.replyAnswerSent, 0);
  assert.deepEqual(sent.map(row => row.target), ['group:one', 'group:two', 'c2c:person']); assert.deepEqual(current, []);
  assert(sent.every(row => row.text.endsWith('same public announcement')));
  await reset('warmup'); await run('warmup'); assert.equal(sent.length, 0);
  await reset('partial-failure'); failTarget = 'group:two'; await run('batch');
  assert.deepEqual(sent.map(row => row.target), ['group:one']);
  assert.equal((await controller.groupAccess.read(scopeId('group:two'))).taskBlocked, 'SEND_FAILED');
  await reset('target-revoked'); mutation = async () => controller.groupAccess.update(scopeId('group:one'), group => { group.allowed = false; });
  await run('batch'); assert.equal(sent.length, 0);
  await reset('private-disabled'); mutation = async () => store.write(join(root, 'chat-access.json'), { publicPrivateChat: false });
  await run('batch'); assert.deepEqual(sent.map(row => row.target), ['c2c:person', 'c2c:operator']);
  assert.equal((await controller.replyContacts.get('c2c:person')).blocked, false);
  await reset('media'); await run('batch'); assert.equal(sent.length, 1); assert.equal(sent[0].media, true);
  assert.deepEqual(checked, ['broadcast', 'warmup', 'partial-failure', 'target-revoked', 'private-disabled', 'media']);

  // Ordinary private input can be a signal, and known private recipients are
  // removed from routing immediately on blocking/clearing or access revocation.
  await reset('directory');
  const routing = await controller.replyRouting.session('c2c:other-person', 'fixture', () => true);
  assert(routing.targets.some(target => target.id === groupAlias('one')));
  assert(routing.targets.some(target => target.id === privateAlias('person')));
  assert(!routing.targets.some(target => target.id === privateAlias('other-person')));
  await routing.send(groupAlias('one'), 'private signal, public content');
  assert.equal(sent[0].text, 'private signal, public content');
  // Consecutive routed sends to the same group, private contact or administrator
  // have no application cooldown; QQ transport still owns platform pacing.
  const scheduledAt = Date.now() + 60000;
  await controller.groupAccess.update(scopeId('group:one'), group => { group.nextMessageAt = scheduledAt; });
  for (const target of [groupAlias('one'), privateAlias('person'), 'admin:1']) {
    await routing.send(target, 'first part');
    await routing.send(target, 'second part');
  }
  assert.deepEqual(sent.slice(1).map(row => row.target), ['group:one', 'group:one', 'c2c:person', 'c2c:person', 'c2c:operator', 'c2c:operator']);
  const afterParts = await controller.groupAccess.read(scopeId('group:one'));
  assert.equal(afterParts.nextMessageAt, scheduledAt);
  assert.equal(afterParts.pushPending, false);
  assert.equal(afterParts.pushOwner, undefined);
  // Closing input to other people does not hide recipients or require an
  // administrator to have sent an ordinary message before receiving output.
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: false });
  assert.equal(await controller.replyContacts.get('c2c:operator'), undefined);
  const inputClosed = await controller.replyRouting.session('c2c:operator', 'input-closed', () => true);
  assert(inputClosed.targets.some(target => target.id === privateAlias('person')));
  await inputClosed.send(privateAlias('person'), 'outgoing remains allowed');
  const groupInputClosed = await controller.replyRouting.session('group:source', 'group-input-closed', () => true);
  assert(groupInputClosed.targets.some(target => target.id === 'admin:1'));
  await groupInputClosed.send('admin:1', 'public administrator notice');
  await assert.rejects(assertReplyAccess('c2c:person', controller, () => true), /PRIVATE_CHAT_DISABLED/);
  await assertReplyAccess('c2c:operator', controller, () => true);
  await assert.rejects(assertDeliveryAccess('c2c:person', controller, () => false), /REPLY_TURN_EXPIRED/);
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: true });
  await assert.rejects(routing.send(privateAlias('unknown'), 'no'), /REPLY_TARGET_NOT_ALLOWED/);
  await controller.replyContacts.block('c2c:person');
  await assert.rejects(routing.send(privateAlias('person'), 'no'), /REPLY_TARGET_NOT_ALLOWED/);
  await controller.replyContacts.observe(privateMessage('person'));
  await controller.replyContacts.remove('c2c:person');
  await assert.rejects(routing.send(privateAlias('person'), 'no'), /REPLY_TARGET_NOT_ALLOWED/);
  await controller.replyContacts.observe(privateMessage('person', 'Recipient'));
  const targets = await controller.taskControls.targets('c2c:operator');
  assert(targets.some(target => target.scope === 'c2c:person'));
  await controller.taskControls.handle('c2c:operator', `/stop ${scopeId('c2c:person')}`);
  assert.equal((await controller.replyContacts.get('c2c:person')).blocked, true);
  await controller.chatRecords.clear('c2c:person'); assert.equal(await controller.replyContacts.get('c2c:person'), undefined);
  let foregroundCalls = 0; controller.requests.enqueue = async () => { foregroundCalls++; };
  await controller.messages.handle(privateMessage('new-person', 'New'), async () => {});
  assert.equal(foregroundCalls, 1); assert.equal((await controller.replyContacts.get('c2c:new-person')).name, 'New');
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: false });
  await controller.messages.handle(privateMessage('blocked-new-person'), async () => {});
  assert.equal(await controller.replyContacts.get('c2c:blocked-new-person'), undefined);
  console.log('Offline routing checks passed: group/private signals, sequential multi-target sends, partial failure, media scope, revocation and contact lifecycle.');
} finally { await controller?.close(); await rm(root, { recursive: true, force: true }); }
