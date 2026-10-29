import { SnowLumaTransport } from '../lib/snowluma-transport.mjs';
import { snowIdentity, snowRecipient } from '../lib/snowluma-identity.mjs';
import { z } from 'zod';
// Offline only: disposable state, real reply IPC and fake QQ responses; no network/model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { scopeId } from '../lib/policy.mjs';
import { VideoController } from '../lib/controller.mjs';
import { ChatDelivery } from '../lib/chat-delivery.mjs';
import { DeliveryDiagnostics } from '../lib/delivery-errors.mjs';
import { ChatResponse } from '../lib/chat-response.mjs';
import { ConversationRequests } from '../lib/conversation-requests.mjs';
import { GroupPush } from '../lib/group-push.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { SerialQueue } from '../lib/serial-queue.mjs';
import { registerReplyTools } from '../lib/tools/replies.mjs';
import { resolveReplyInteraction } from '../lib/reply-interaction.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-send-limits-'));
const store = new Store(root);
let controller; let bridge;
try {
  {
const calls = []; let chunk;
const transport = new SnowLumaTransport({ account: '123456', url: 'http://snowluma:3000/', token: 'fixture', fetch: async (url, init) => {
 const {action,params} = JSON.parse(init.body); calls.push({action,params});
 let data = {message_id:42};
 if(action==='upload_file_stream') {
  if(!params.is_complete) chunk=params;
  data = params.is_complete ? {type:'response',status:'file_complete',stream_id:params.stream_id,received_chunks:1,total_chunks:1,file_size:chunk.file_size,file_path:'/fixture/upload',file_name:chunk.filename,sha256:'0'.repeat(64)}
   :{type:'stream',status:'chunk_received',stream_id:params.stream_id,total_chunks:1,received_chunks:1};
 }
 return new Response(JSON.stringify({status:'ok',retcode:0,data,...(action==='upload_file_stream'?{stream:'stream-action'}:{})})+'\n');
}});
const guards={beforeCommit:async()=>{},onDispatch:()=>{},onStage:()=>{}};
await transport.send({scope:'c2c',targetId:'sl~123456~654321'},{text:'literal [CQ:at,qq=all]'},guards);
assert.equal(calls[0].params.message[0].data.text,'literal [CQ:at,qq=all]');
await transport.send({scope:'group',targetId:'sl~123456~654321'},{media:{type:'image',bytes:Buffer.from('GIF89a')}},guards);
assert.deepEqual(calls.map(x=>x.action),['send_private_msg','upload_file_stream','upload_file_stream','send_group_msg']);
await transport.send({scope:'group',targetId:'sl~123456~777777'}, {interaction:{type:'poke',sender:654321}}, guards);
assert.deepEqual(calls.at(-1), {action:'group_poke',params:{group_id:777777,user_id:654321}});
await transport.send({scope:'c2c',targetId:'sl~123456~654321'}, {interaction:{type:'poke',sender:654321}}, guards);
assert.deepEqual(calls.at(-1), {action:'friend_poke',params:{user_id:654321}});
await transport.send({scope:'group',targetId:'sl~123456~777777'}, {interaction:{type:'reaction',messageId:-42,emojiId:'76',set:false}}, guards);
assert.deepEqual(calls.at(-1), {action:'set_msg_emoji_like',params:{message_id:-42,emoji_id:'76',set:false}});
const commandMenu = { rows: [[{ label: '编辑角色', command: '/persona custom ', enter: false }],
  [{ label: '下一页', command: '/models 2' }, { label: '返回', command: '/settings' }]] };
for (const scope of ['c2c', 'group']) {
  await transport.send({ scope, targetId: 'sl~123456~654321' }, { text: '可用指令：', buttons: commandMenu }, guards);
  const sent = calls.at(-1);
  assert.equal(sent.action, scope === 'group' ? 'send_group_msg' : 'send_private_msg');
  assert.deepEqual(sent.params.message, [{ type: 'text', data: { text: '可用指令：\n\n普通操作直接发送指令；编辑操作按格式填写参数，示例中的值请自行替换。\n\n编辑角色（编辑后发送）\n格式：/persona custom <内容>\n示例（请替换为你要设置的值）：\n/persona custom 新内容\n\n下一页\n/models 2\n\n返回\n/settings' } }]);
}


assert.throws(() => snowRecipient('123456', 'legacy-openid'), /TARGET_MISMATCH/);
assert.throws(() => snowRecipient('777777', snowIdentity('123456', '654321')), /TARGET_MISMATCH/);
for (const status of [429, 500]) {
 let sends = 0;
 const rejected = new SnowLumaTransport({account:'123456',url:'http://snowluma:3000/',token:'fixture',fetch:async()=>{ sends++;return new Response('private provider error',{status}); }});
 await assert.rejects(rejected.send({scope:'c2c',targetId:'sl~123456~654321'},{text:'one'},guards),error => error.message === (status === 429 ? 'QQ_RATE_LIMITED' : 'SNOWLUMA_HTTP_REJECTED') && error.httpStatus === status);
 assert.equal(sends,1);
}
const before = calls.length;
let checks = 0;
await assert.rejects(transport.send({scope:'c2c',targetId:'sl~123456~654321'}, {media:{type:'image',bytes:Buffer.from('GIF89a')}},
 {...guards,beforeCommit:async()=>{if(++checks===3)throw new Error('ACCESS_REVOKED');}}), /ACCESS_REVOKED/);
assert.deepEqual(calls.slice(before).map(x=>x.action),['upload_file_stream']);
  }
  const queue = new SerialQueue(); const ordered = [];
  let timer;
  try {
    await Promise.race([
      Promise.all([1, 2, 3].map(i => queue.run(async () => { ordered.push(i); }))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LOCAL_SEND_DELAY')), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(ordered, [1, 2, 3]);
  await assert.rejects(queue.run(async () => { throw new Error('fixture'); }), /fixture/);
  await queue.run(async () => ordered.push(4)); assert.equal(ordered.at(-1), 4);

  controller = new VideoController({ store, admins: ['operator'], adapter: { close: async () => {}, reset: async () => {} } });
  const scope = 'group:fixture'; const id = scopeId(scope);
  await store.write(controller.groupAccess.path(id), { id, openid: 'fixture', name: 'Fixture', allowed: true,
    listen: true, engage: true, push: true, toolMonitor: true, observedAt: new Date().toISOString() });
  const calls = []; const events = []; let rejectNext = null; let rejectAll = false;
  const limited = (httpStatus = 429, bizCode) => Object.assign(new Error('QQ_RATE_LIMITED'), {
    httpStatus, bizCode, traceId: 'fixture-trace', bizMessage: 'fixture-secret rate limit', body: 'UNTRUSTED_BODY',
  });
  assert.throws(() => new ChatDelivery({}), /CHAT_TRANSPORT_REQUIRED/);
  const delivery = new ChatDelivery({ diagnostics: new DeliveryDiagnostics(),
    onState: (state, details) => events.push({ state, ...details }), assertCanContinue: async () => {},
    notifyAdmins: report => notices.send(report), transport: async (target, { text }, { beforeCommit }) => {
      await beforeCommit();
      calls.push({ target, text });
      if (rejectAll) throw limited();
      if (rejectNext && target.targetId !== 'operator') { const error = rejectNext; rejectNext = null; throw error; }
      return { id: 'accepted' };
    } });
  const notices = new AdminNotifications(controller, delivery);
  controller.sendRoutedReply = (scope, text, isActive, beforeSend, media, beforeCommit) =>
    delivery.send(scope, { text, media }, { isActive, beforeSend, beforeCommit });
  const target = { scope: 'group', targetId: 'fixture' };
  for (const error of [limited(), limited(400, 777)]) {
    const before = calls.length; rejectNext = error;
    await assert.rejects(delivery.send(scope, 'limited'), result => result.message === 'QQ_RATE_LIMITED'
      && result.traceId === 'fixture-trace' && result.httpStatus === error.httpStatus);
    assert.equal(calls.length, before + 2); // One rejected call plus one administrator notice.
    assert.equal(calls.at(-1).target.targetId, 'operator');
    assert(calls.at(-1).text.includes('限流')); assert(!calls.at(-1).text.includes('fixture-secret'));
  }
  // Notification failures must not recurse or fall back to the source chat.
  rejectAll = true; const beforeNoticeFailure = calls.length;
  await assert.rejects(delivery.send(scope, 'limited'), /QQ_RATE_LIMITED/);
  assert.equal(calls.length, beforeNoticeFailure + 2); rejectAll = false;

  const routing = await controller.replyRouting.session('c2c:operator', 'routing', () => true);
  rejectNext = limited();
  await assert.rejects(routing.send(`group:${id}`, 'limited routed message'), /QQ_RATE_LIMITED/);
  let group = await controller.groupAccess.read(id);
  assert(!group.taskBlocked); assert.equal(group.pushPending, false); assert.equal(group.pushOwner, undefined);
  await routing.send(`group:${id}`, 'new routed message');

  const publisher = new GroupPush(controller.groupAccess, controller.groupContext,
    (openid, text, { media, ...options } = {}) => delivery.send(`group:${openid}`, { text, media }, options), error => delivery.diagnostics.format('failed', error),
    (state, details) => events.push({ state, ...details }), error => delivery.diagnostics.errorDetails(error));
  const sender = publisher.replies(id, 'chat', { requestId: 'group', scope, isActive: () => true, stopReason: () => 'STOPPED' });
  rejectNext = limited(); await assert.rejects(sender.sendPart('limited group reply', () => true), /QQ_RATE_LIMITED/);
  assert.equal(sender.failed, false); assert.equal((await controller.groupAccess.read(id)).pushPending, false);
  await sender.sendPart('new group reply', () => true); assert.equal(sender.sent, 1);
  assert(events.some(event => event.state === 'group_reply_rejected'));
  assert(!events.some(event => event.state === 'group_push_failed'));

  const response = new ChatResponse({ message: { kind: 'group', groupOpenid: 'fixture', requestId: 'current',
    replyTarget: { ...target, msgId: 'incoming' } }, delivery, debug: { record() {} }, onState() {} });
  bridge = await ReplyBridge.open(); const turnId = randomUUID();
  const binding = bridge.bind({ id: turnId, send: (text, _target, _media, isActive) => response.send({ event: 'reply-part', text, isActive }) });
  let action; let failure; let replySchema;
  registerReplyTools((name, _description, _schema, run, onFailure) => { assert.equal(name, 'send_reply'); replySchema = z.object(_schema); action = run; failure = onFailure; }, bridge.path);
  assert.equal(replySchema.shape.kind, undefined);
  const args = { turn_id: turnId, part_id: 1, target: 'current', text: 'not delivered' };
  rejectNext = limited();
  const raw = await callReplyBridge(bridge.path, args);
  assert.equal(raw.code, 'QQ_RATE_LIMITED'); assert.equal(raw.delivery, 'rejected');
  assert.equal(raw.platform.httpStatus, 429); assert.equal(raw.platform.traceId, 'fixture-trace');
  assert(!JSON.stringify(raw).includes('UNTRUSTED_BODY'));
  assert.equal(binding.turn.failed, false); assert.equal(binding.turn.currentRejected, true); assert.equal(response.failed, false);
  // Reusing the rejected part ID returns the same result without resubmission.
  const beforeRepeat = calls.length;
  await assert.rejects(action(args), error => {
    const result = failure(error).content[0].single();
    return result.code === 'QQ_RATE_LIMITED' && result.platform.httpStatus === 429 && result.recovery.includes('Do not') && result.rate_limited;
  });
  assert.equal(calls.length, beforeRepeat);
  const verbatim = '  标点，和换行。\n[资料](https://example.com) ' + '长回复'.repeat(800);
  const longArgs = replySchema.parse({ ...args, part_id: 2, text: verbatim });
  await action(longArgs); assert.equal(binding.turn.answerSent, 1);
  assert.equal(calls.at(-1).text, verbatim);
  // Uncertain delivery retains the normal terminal stop rule.
  rejectNext = Object.assign(new Error('timeout'), { httpStatus: 0 });
  await assert.rejects(action({ ...args, part_id: 3, text: 'uncertain' }), /QQ_REPLY_FAILED/);
  assert.equal(binding.turn.failed, true); assert.equal(response.failed, true);
  group = await controller.groupAccess.read(id); assert(!group.taskBlocked);
  // Current-chat rejection avoids compensation, while
  // leaving task completion and future group processing available.
  controller.adapter.run = async () => ({ replyCurrentRejected: true,
    replyAnswerSent: 0, replyDeliveryFailed: false, sharedState: null });
  const result = await controller.run('c2c:operator', 'fixture', {});
  assert.equal(result.replyCurrentRejected, true);
  let videoFallback = 0; let bodyFallback = 0;
  const lane = { tail: Promise.resolve(), epoch: 0, pending: 0, active: null, failures: 0, interruptedWork: [] };
  await controller.groupAccess.update(id, value => { value.toolMonitor = false; });
  const tasks = new ConversationRequests({ groupAccess: controller.groupAccess, groupContext: controller.groupContext, store,
    lane: () => lane, foregroundPending: () => false, closed: false, debug: { record() {} },
    reportTaskFailure: async () => { throw new Error('RATE_LIMIT_PAUSED_TASK'); },
    run: async () => ({ ...result, startedAt: new Date().toISOString(),
      groupRevision: 0, groupEpoch: (await controller.groupContext.batchStatus(scope)).epoch }),
    groupPublisher: { replies: () => ({ sent: 0, sendPart: async () => { bodyFallback++; }, close() {} }),
      deliver: async () => { videoFallback++; } },
  });
  await tasks.process(await controller.groupAccess.read(id), { kind: 'batch', reason: 'mention', status: { pendingCount: 1, pendingChars: 1 } });
  assert.equal(bodyFallback, 0); assert.equal(videoFallback, 0);
  assert.equal(lane.failures, 0); assert(!(await controller.groupAccess.read(id)).taskBlocked);
  // Successful silent chat completion never sends a message or saved video.
  controller.adapter.run = async () => ({ sharedState: null });
  let silentSends = 0;
  await controller.run('c2c:operator', 'silent fixture', {}, { onReply: async () => { silentSends++; } });
  assert.equal(silentSends, 0);
  result.replyCurrentRejected = false;
  await tasks.process(await controller.groupAccess.read(id), { kind: 'batch', reason: 'mention', status: { pendingCount: 1, pendingChars: 1 } });
  assert.equal(bodyFallback, 0); assert.equal(videoFallback, 0);
  await tasks.process(await controller.groupAccess.read(id), { kind: 'discover', reason: 'video', status: { pendingCount: 0, pendingChars: 0 } });
  assert.equal(bodyFallback, 0); assert.equal(videoFallback, 1); // Dedicated discovery publication remains.

  // Interaction-only sends use actual retained speakers, the common controller,
  // reply IPC idempotency, group reservations and the guarded delivery boundary.
  const interactionScope = 'group:sl~123456~777777', interactionGroup = scopeId(interactionScope);
  await store.write(controller.groupAccess.path(interactionGroup), { id: interactionGroup, openid: 'sl~123456~777777',
    allowed: true, listen: true, engage: true, observedAt: new Date().toISOString() });
  await controller.messageRecords.capture(interactionScope, { kind: 'group', groupOpenid: 'sl~123456~777777',
    senderId: 'sl~123456~654321', messageId: 'slmsg~-42', content: 'synthetic interaction target' }, null, true);
  const poke = { type:'poke', message_id:'slmsg~-42' };
  const reaction = { type:'reaction', message_id:'slmsg~-42', emoji_id:'76', set:false };
  const interactionCalls = []; let archived = 0; let rejectInteraction = null;
  const interactionDelivery = new ChatDelivery({ diagnostics: new DeliveryDiagnostics(), assertCanContinue: async () => {},
    notifyAdmins: async () => {}, rememberReply: async () => { archived++; }, transport: async (_target, content, guards) => {
      await guards.beforeCommit(); interactionCalls.push(content.interaction);
      if (rejectInteraction) throw rejectInteraction;
      return { accepted: true };
    } });
  const interactionPublisher = new GroupPush(controller.groupAccess, controller.groupContext,
    (openid, text, {interaction,...options}) => interactionDelivery.send(`group:${openid}`, {text,interaction}, {...options,history:true}),
    () => 'failure', () => {}, () => ({}));
  const interactionSender = interactionPublisher.replies(interactionGroup, 'batch', { requestId:'interaction', scope:interactionScope,
    isActive:()=>true, stopReason:()=> 'STOPPED' });
  const interactionBridge = await ReplyBridge.open(); let interactionBinding;
  try {
    controller.adapter.run = async options => {
      const token = randomUUID();
      interactionBinding = interactionBridge.bind({ id:token, send: options.onReply });
      const call = (part_id, interaction, extra={}) => callReplyBridge(interactionBridge.path,
        {turn_id:token,part_id,interaction,...extra});
      assert.equal((await call(1,poke,{text:'mixed'})).code,'REPLY_INTERACTION_INVALID');
      assert.equal((await call(1,poke,{target:'admin:1'})).code,'REPLY_INTERACTION_INVALID');
      const acceptedPoke = await call(1,poke);
      assert(acceptedPoke.ok); assert.equal(acceptedPoke.messages_sent,0); assert.equal(acceptedPoke.interactions_sent,1);
      assert((await call(1,poke)).ok); assert.equal(interactionCalls.length,1);
      assert.equal((await call(1,reaction)).code,'REPLY_PART_CONFLICT');
      assert((await call(2,reaction)).ok); assert.equal(interactionCalls.length,2);
      rejectInteraction = limited();
      assert.equal((await call(3,poke)).code,'QQ_RATE_LIMITED');
      assert(!interactionBinding.turn.failed); assert(!interactionSender.failed);
      assert.equal((await controller.groupAccess.read(interactionGroup)).pushPending,false);
      rejectInteraction = new Error('UNCERTAIN_INTERACTION');
      assert.equal((await call(4,poke)).ok,false);
      assert(interactionBinding.turn.failed); assert(interactionSender.failed);
      const attempts = interactionCalls.length;
      assert.equal((await call(5,poke)).ok,false); assert.equal(interactionCalls.length,attempts);
      await interactionBinding.close();
      return {sharedState:null};
    };
    await controller.run(interactionScope,'fixture',{}, { background:true,purpose:'batch',
      onReply:(text,active,media,interaction)=>interactionSender.sendPart(text,active,media,interaction) });
    assert.equal(interactionCalls[0].sender,654321); assert.equal(interactionCalls[1].messageId,-42); assert.equal(archived,0);
    assert(!controller.debug.read(interactionScope).lastError?.includes('654321'));
    await assert.rejects(resolveReplyInteraction(interactionScope,{...poke,message_id:'element:foreign'},controller,async()=>{}),/REPLY_INTERACTION_INVALID/);
    await assert.rejects(resolveReplyInteraction('group:other',poke,controller,async()=>{}),/REPLY_INTERACTION_UNAVAILABLE/);
    const resolved = await resolveReplyInteraction(interactionScope,poke,controller,async()=>{});
    await controller.groupAccess.update(interactionGroup,row=>{row.listen=false;});
    const count = interactionCalls.length;
    await assert.rejects(interactionDelivery.send(interactionScope,{interaction:resolved}),/GROUP_MESSAGES_DISABLED/);
    assert.equal(interactionCalls.length,count);
    await controller.groupAccess.update(interactionGroup,row=>{row.listen=true;});
    await controller.messageRecords.clear(interactionScope);
    await assert.rejects(resolved.assertAccess(),/INTERACTION_MESSAGE_UNAVAILABLE/);
    assert(!replySchema.safeParse({turn_id:randomUUID(),part_id:1,interaction:{...poke,emoji_id:'76'}}).success);
    rejectInteraction = null;
    const privateScope = 'c2c:sl~123456~654321';
    await controller.messageRecords.capture(privateScope, { kind:'c2c',senderId:'sl~123456~654321',messageId:'slmsg~-42',content:'fixture' },false);
    const privateResponse = new ChatResponse({message:{kind:'c2c',senderId:'sl~123456~654321'},
      delivery:interactionDelivery,debug:{record(){}},onState(){} });
    controller.adapter.run = async options => {
      await options.onReply('', 'current', undefined, ()=>true, poke);
      return {sharedState:null};
    };
    await controller.run(privateScope,'fixture',{}, {onReply:(text,isActive,media,interaction)=>
      privateResponse.send({event:'reply-part',text,isActive,media,interaction})});
    assert.equal(privateResponse.replyParts,1); assert.equal(interactionCalls.at(-1).sender,654321); assert.equal(archived,0);
  } finally { await interactionBinding?.close(); await interactionBridge.close(); }

  console.log('Offline send-limit checks passed: no local delay, typed platform rejection, private notices without recursion, group reservations, live IPC/model errors, idempotency and uncertain-delivery stop.');
} finally { await bridge?.close(); await controller?.close(); await rm(root, { recursive: true, force: true }); }
