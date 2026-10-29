// Offline: disposable records, local IPC, fake inference and no QQ/media I/O.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { registerChatContextTools } from '../lib/tools/chat-context.mjs';
import { toolRegistrar } from '../lib/tools/register.mjs';
import { toolPolicy } from '../lib/tool-policy.mjs';
import { ContextAccess } from '../lib/context-access.mjs';
import { registerMessageTools } from '../lib/tools/messages.mjs';
import { registerMessageImageTools } from '../lib/tools/message-images.mjs';
import { ChatDelivery } from '../lib/chat-delivery.mjs';
import { DeliveryDiagnostics } from '../lib/delivery-errors.mjs';
import { Files } from '../lib/files.mjs';
import { SnowLumaFaces } from '../lib/snowluma-faces.mjs';
import { SnowLumaHistory, historyQuery } from '../lib/snowluma-history.mjs';
import { MessageMedia } from '../lib/message-media.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-chat-context-'));
const store = new Store(root); let controller; let bridge; let closeMessages;
const request = (operation, extra = {}) => ({ operation, offset: 0, limit: 20, ...extra });
const message = (kind, id, content) => ({ kind, senderId: kind === 'group' ? 'SPEAKER_ID_SENTINEL' : id,
  senderName: 'PRIVATE_NAME_SENTINEL', groupOpenid: kind === 'group' ? id : undefined,
  messageId: randomUUID(), timestamp: new Date().toISOString(), content, images: [] });
try {
  let inspectRun;
  controller = new VideoController({ store, admins: ['operator'], adapter: {
    reset: async () => {}, close: async () => {}, run: async options => { await inspectRun(options); return { sharedState: null }; },
  } });
  for (const [name, flags] of [['source', {}], ['target', {}], ['denied', { allowed: false }], ['stopped', { taskBlocked: 'ADMIN_STOPPED' }], ['uncollected', { listen: false }]]) {
    await store.write(controller.groupAccess.path(scopeId(`group:${name}`)), {
      id: scopeId(`group:${name}`), openid: name, name: `Fixture ${name}`, allowed: true, listen: true, engage: true,
      observedAt: new Date().toISOString(), ...flags,
    });
  }
  const groupMessage = message('group', 'target', 'shared group text');
  groupMessage.structure = await controller.messageRecords.capture('group:target', groupMessage, null, true);
  await controller.groupContext.append(groupMessage);
  const batchBefore = await controller.groupContext.batchStatus('group:target');
  const privateMessage = message('c2c', 'person', 'PRIVATE_TEXT_FIXTURE');
  await controller.replyContacts.observe(privateMessage);
  await controller.messageRecords.capture('c2c:person', privateMessage, false);
  const source = 'group:source'; let active = true;
  const check = async () => { if (!active) throw new Error('CONTEXT_SOURCE_UNAVAILABLE'); };
  const reader = controller.chatContext.session(source, check);
  let directory = await reader(request('list'));
  assert.equal(directory.items.length, 1); assert.equal(directory.items[0].kind, 'group');
  const target = directory.items[0].id;
  const groupPage = await reader(request('read', { target, query: 'group' }));
  assert.equal(groupPage.items[0].components[0].text, 'shared group text');
  assert(groupPage.items[0].speaker.alias.startsWith('speaker:'));
  assert(!JSON.stringify(groupPage).includes('SPEAKER_ID_SENTINEL'));
  const referenceOnly = message('group', 'target', 'REF_ONLY_FIXTURE');
  referenceOnly.attachments = Array.from({ length: 80 }, (_, i) => ({ content_type: 'file', filename: `fixture-${i}.txt` }));
  await controller.messageRecords.capture('group:target', referenceOnly, null, true);
  const referencePage = await reader(request('read', { target, query: 'REF_ONLY_FIXTURE' }));
  assert.equal(referencePage.items[0].type, 'record_ref');
  assert.equal(referencePage.items[0].messageId, referenceOnly.messageId);
  assert(!('components' in referencePage.items[0]));
  assert(!JSON.stringify(groupPage).includes('PRIVATE_NAME_SENTINEL'));
  assert.equal(groupPage.items[0].messageId, groupMessage.messageId); // Graph reference for shared detail reads.
  assert.equal((await reader(request('read', { target, query: 'no-match' }))).items.length, 0);
  await assert.rejects(reader(request('read', { target: 'group:target' })), /CONTEXT_TARGET_UNAVAILABLE/);
  await assert.rejects(reader(request('read', { target, since: 'invalid' })), /CONTEXT_QUERY_INVALID/);
  assert.deepEqual(await controller.groupContext.batchStatus('group:target'), batchBefore);
  // Private sharing is self-service and off by default; group callers cannot toggle it.
  const who = { scope: 'c2c:person', private: true, admin: false };
  assert.equal((await controller.adminSettings.read(who.scope)).shareContext, false);
  await controller.chatContext.sharing({ scope: source, private: false }, '/context-sharing on');
  assert.equal((await controller.adminSettings.read(who.scope)).shareContext, false);
  const replies = [];
  await controller.commands.dispatch({ who, text: '/context-sharing on', reply: async value => replies.push(value) });
  assert.equal(replies.length, 1); assert(replies[0].text.includes('包括群聊'));
  await controller.adminSettings.update(who.scope, settings => { settings.toolMonitor = true; });
  assert.equal((await controller.adminSettings.read(who.scope)).shareContext, true);
  directory = await reader(request('list'));
  const privateTarget = directory.items.find(row => row.kind === 'private').id;
  assert.equal((await reader(request('read', { target: privateTarget }))).items[0].components[0].text, 'PRIVATE_TEXT_FIXTURE');
  await controller.chatContext.sharing(who, '/context-sharing off');
  await assert.rejects(reader(request('read', { target: privateTarget })), /CONTEXT_NOT_SHARED/);
  await controller.chatContext.sharing(who, '/context-sharing on');
  await assert.rejects(reader(request('read', { target: privateTarget })), /CONTEXT_NOT_SHARED/);
  assert.notEqual((await reader(request('list'))).items.find(row => row.kind === 'private').id, privateTarget);
  // New turn aliases cannot reuse another turn's grants.
  const other = controller.chatContext.session('c2c:operator', check);
  await assert.rejects(other(request('read', { target })), /CONTEXT_TARGET_UNAVAILABLE/);
  // Live revocation and post-acquisition checks discard buffered text.
  const originalPage = controller.messageRecords.contextPage.bind(controller.messageRecords);
  controller.messageRecords.contextPage = async (...args) => {
    const page = await originalPage(...args);
    await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = false; });
    return page;
  };
  await assert.rejects(reader(request('read', { target })), /CONTEXT_TARGET_UNAVAILABLE/);
  controller.messageRecords.contextPage = originalPage;
  // Seven-day retention does not evict either direction by count.
  const retainedScope = 'c2c:retention-fixture';
  const retainedIncoming = await controller.messageRecords.capture(retainedScope, message('c2c', 'retention-fixture', 'original survives'), false);
  const retainedDb = await controller.messageRecords.database(retainedScope);
  retainedDb.exec('BEGIN IMMEDIATE');
  try {
    const insert = retainedDb.prepare('INSERT INTO records(id,received,historical,body) VALUES(?,?,1,?)');
    for (let i = 0; i < 513; i++) insert.run(`reply:retention-${i}`, Date.now(), JSON.stringify({ type: 'record',
      messageId: `reply:retention-${i}`, source: 'bot_reply', speaker: { role: 'assistant' }, components: [{ type: 'text', text: 'fixture' }] }));
    controller.messageRecords.prune(retainedDb); retainedDb.exec('COMMIT');
  } catch (error) { retainedDb.exec('ROLLBACK'); throw error; }
  assert(await controller.messageRecords.find(retainedScope, retainedIncoming.messageId));
  assert.equal(retainedDb.prepare("SELECT count(*) AS n FROM records WHERE json_extract(body,'$.source')='bot_reply'").get().n, 513);
  await assert.rejects(controller.messageRecords.captureReply(retainedScope, { text: 'late history' }, { id: 'late-fixture' },
    async () => { throw new Error('REPLY_HISTORY_SCOPE_CLOSED'); }), /REPLY_HISTORY_SCOPE_CLOSED/);
  assert.equal(await controller.messageRecords.find(retainedScope, 'reply:late-fixture'), null);
  await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = true; });
  controller.lane('group:target').epoch++;
  await assert.rejects(reader(request('read', { target })), /CONTEXT_TARGET_UNAVAILABLE/);
  active = false;
  await assert.rejects(reader(request('list')), /CONTEXT_SOURCE_UNAVAILABLE/); active = true;
  // Actual MCP encoding and local turn-token IPC, with no model connection.
  bridge = await ReplyBridge.open();
  const turnId = randomUUID(); const session = controller.chatContext.session(source, check);
  const binding = bridge.bind({ id: turnId, chatContext: session });
  const tools = new Map();
  registerChatContextTools(toolRegistrar({ registerTool(name, options, action) { tools.set(name, { options, action }); } }, toolPolicy()), bridge.path);
  const listed = await tools.get('list_context_chats').action({ turn_id: turnId, offset: 0, limit: 20 });
  assert(!listed.isError);
  const alias = JSON.parse(listed.content[0].text).items.find(row => row.kind === 'group').id;
  const read = await tools.get('read_chat_context').action({ turn_id: turnId, target: alias, query: '', since: '', until: '', offset: 0, limit: 20 });
  assert(!read.isError); assert(JSON.stringify(read).includes('shared group text'));
  {
const face={q_sid:'76',q_des:'赞',emoji_name_alias:['强'],url:'PRIVATE_URL',extra:'PRIVATE_FIELD'};
const c={ready:true,accepting:true,generation:1,account:'111111',client:{
 searchSysFaces:async query=>({faces:query==='missing'?[]:[face]}),fetchFaceEntity:async id=>id===76?face:null}};
const owner=new SnowLumaFaces(c);
assert.deepEqual((await owner.search('赞',async()=>{})).items,[{emoji_id:'76',name:'赞',aliases:['强']}]);
assert.equal((await owner.search('76',async()=>{})).items[0].name,'赞');
assert.equal((await owner.search('missing',async()=>{})).items.length,0);
assert(!JSON.stringify(await owner.search('赞',async()=>{})).includes('PRIVATE'));
c.client.searchSysFaces=async()=>{c.generation++;return {faces:[face]};};
await assert.rejects(owner.search('赞',async()=>{}),/SNOWLUMA_CONNECTION_UNAVAILABLE/);

  c.client.searchSysFaces=async()=>({faces:[face]});
  controller.searchFaces=(query,check,signal)=>owner.search(query,check,signal);
  const lookup = await tools.get('search_qq_faces').action({turn_id:turnId,query:'赞'});
  assert(!lookup.isError); assert.equal(JSON.parse(lookup.content[0].text).items[0].name,'赞');
  assert((await tools.get('search_qq_faces').action({turn_id:randomUUID(),query:'赞'})).isError);
  c.client.searchSysFaces=async()=>{active=false;return {faces:[face]};};
  assert((await tools.get('search_qq_faces').action({turn_id:turnId,query:'赞'})).isError);
  active=true; delete controller.searchFaces;
  }
  // Remote history is transient SDK paging, never local-event backfill.
  const historyTime = Math.floor(Date.now() / 1000) - 60;
  const historyRow = (id, seconds, text = 'Needle body') => ({ message_id: id, time: seconds,
    sender: { user_id: 555555, nickname: 'HISTORY_SENDER_PRIVATE' },
    message: [{ type: 'text', data: { text } }, { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/private-pointer' } },
      { type: 'forward', data: { id: 'HISTORY_FORWARD_PRIVATE' } }] });
  const hrows = [9, 70, 2, 80].map((id, i) => historyRow(id, historyTime - i));
  let hcalls = [], hmode = 'pages';
  const hchannel = { account: '111111', ready: true, accepting: true, stopped: false, generation: 1, client: {
    getGroupMessageHistory: async (params, options) => {
      hcalls.push(params); assert.equal(params.count, 20); assert.equal(params.reverse_order, true); assert.equal(options.timeoutMs, 10000);
      if (hmode === 'reconnect') { hchannel.generation++; return { messages: hrows }; }
      if (hmode === 'error') throw new Error('SECRET_RAW_GATEWAY_ERROR');
      if (hmode === 'malformed') return { messages: {} };
      if (hmode === 'misroute') return { messages: [{ ...hrows[0], group_id: 999999 }] };
      if (hmode === 'repeated') return { messages: [hrows[0]] };
      if (hmode === 'filters') return { messages: [historyRow(1, historyTime, 'other'), historyRow(2, historyTime - 1, 'NEEDLE match'),
        historyRow(3, historyTime - 2, '/stop'), historyRow(4, historyTime - 3, 'needle outside')] };
      const index = params.message_id == null ? 0 : hrows.findIndex(row => row.message_id === params.message_id);
      return { messages: index === 3 ? [] : hrows.slice(index, index + 2).reverse() }; // SDK order is not assumed.
    },
    getFriendMessageHistory: async params => { assert.equal(params.user_id, 222222); return { messages: [] }; },
  } };
  const remoteHistory = new SnowLumaHistory(hchannel);
  const remoteScope = 'group:sl~111111~222222';
  const hstate = () => historyQuery({ query: 'needle' });
  const hfirst = await remoteHistory.read(remoteScope, hstate(), check);
  assert.equal(hfirst.result.items.length, 4); assert.equal(hfirst.result.scanned, 4);
  assert.equal(hfirst.result.status, 'page_budget'); assert.equal(hfirst.state.anchor, 80);
  assert.deepEqual(hcalls.map(row => row.message_id), [undefined, 70, 2]);
  assert(!/HISTORY_SENDER_PRIVATE|HISTORY_FORWARD_PRIVATE|private-pointer|555555/.test(JSON.stringify(hfirst.result)));
  assert.equal(hfirst.result.complete, false);
  assert.equal((await remoteHistory.read(remoteScope, hfirst.state, check)).result.status, 'gateway_exhausted');
  assert.equal((await remoteHistory.read('c2c:sl~111111~222222', hstate(), check)).result.status, 'gateway_exhausted');
  hmode = 'filters';
  const filtered = await remoteHistory.read(remoteScope, historyQuery({ query: 'needle',
    since: new Date((historyTime - 2) * 1000).toISOString(), until: new Date(historyTime * 1000).toISOString() }), check);
  assert.equal(filtered.result.items.length, 1); assert.equal(filtered.result.items[0].text, 'NEEDLE match');
  assert.equal(filtered.result.status, 'paging_stalled');
  const originalGroupHistory = hchannel.client.getGroupMessageHistory;
  hchannel.client.getGroupMessageHistory = async () => ({ messages: [
    historyRow(11, historyTime, 'x'.repeat(500) + ' needle https://multimedia.nt.qq.com.cn/private?secret=HISTORY_URL_SECRET'),
    historyRow(12, historyTime, '/needle control'), { ...historyRow(13, historyTime), time: undefined },
    historyRow(14, historyTime - 8 * 86400, 'needle expired'),
  ] });
  const safeHistory = await remoteHistory.read(remoteScope, hstate(), check);
  assert.equal(safeHistory.result.items.length, 1); assert.equal(safeHistory.result.items[0].truncated, true);
  assert(safeHistory.result.items[0].text.includes('needle')); assert(safeHistory.result.skipped > 0);
  assert(!JSON.stringify(safeHistory.result).includes('HISTORY_URL_SECRET'));
  hchannel.client.getGroupMessageHistory = originalGroupHistory;
  hmode = 'repeated'; assert.equal((await remoteHistory.read(remoteScope, hstate(), check)).result.items.length, 1);
  hmode = 'reconnect'; await assert.rejects(remoteHistory.read(remoteScope, hstate(), check), /SNOWLUMA_CONNECTION_UNAVAILABLE/);
  hmode = 'error'; await assert.rejects(remoteHistory.read(remoteScope, hstate(), check), /^Error: HISTORY_ACQUISITION_FAILED$/);
  hmode = 'malformed'; await assert.rejects(remoteHistory.read(remoteScope, hstate(), check), /HISTORY_RESPONSE_INVALID/);
  hmode = 'misroute'; await assert.rejects(remoteHistory.read(remoteScope, hstate(), check), /HISTORY_RESPONSE_INVALID/);
  const cancelledHistory = new AbortController(); cancelledHistory.abort();
  await assert.rejects(remoteHistory.read(remoteScope, hstate(), check, cancelledHistory.signal), /CONTEXT_SOURCE_UNAVAILABLE/);
  for (const args of [{ query: 'x', since: 'invalid' }, { query: 'x', since: '2020-01-01T00:00:00Z' },
    { query: 'x', since: new Date().toISOString(), until: new Date(Date.now() - 1000).toISOString() }])
    assert.throws(() => historyQuery(args), /CONTEXT_QUERY_INVALID/);
  // Exercise actual tool schema, turn IPC, opaque continuation and revocation.
  hmode = 'pages'; hcalls = [];
  controller.searchHistory = async (scope, state, verify, signal) => {
    assert.equal(scope, 'group:target'); return remoteHistory.read(remoteScope, state, verify, signal);
  };
  const searchTool = tools.get('search_qq_history');
  const searchArgs = { turn_id: turnId, target: alias, query: 'needle' };
  const searchResponse = await searchTool.action(searchArgs);
  assert(!searchResponse.isError, JSON.stringify(searchResponse));
  const searched = JSON.parse(searchResponse.content[0].text);
  assert(searched.nextCursor.startsWith('history:')); assert.equal(searched.items.length, 4);
  assert((await searchTool.action({ ...searchArgs, cursor: searched.nextCursor, query: 'different' })).isError);
  assert((await searchTool.action({ ...searchArgs, cursor: searched.nextCursor, target: 'current' })).isError);
  const continued = await searchTool.action({ turn_id: turnId, target: alias, cursor: searched.nextCursor });
  assert(!continued.isError); assert.equal(JSON.parse(continued.content[0].text).status, 'gateway_exhausted');
  assert((await searchTool.action({ ...searchArgs, cursor: searched.nextCursor })).isError);
  assert((await searchTool.action({ ...searchArgs, turn_id: randomUUID() })).isError);
  assert((await searchTool.action({ ...searchArgs, target: 'chat:' + randomUUID() })).isError);
  assert.equal(await controller.messageRecords.find('group:target', 'slmsg~9'), null);
  controller.searchHistory = async (_scope, state, verify, signal) => {
    const result = await remoteHistory.read(remoteScope, state, verify, signal);
    await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = false; });
    return result;
  };
  const revokedSearch = await searchTool.action(searchArgs);
  assert(revokedSearch.isError); assert(!JSON.stringify(revokedSearch).includes('Needle body'));
  await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = true; });
  controller.searchHistory = async (_scope, state, verify, signal) => {
    await verify(); await controller.chatContext.sharing(who, '/context-sharing off'); await verify();
    return remoteHistory.read(remoteScope, state, verify, signal);
  };
  const historyPrivateAlias = (await session(request('list'))).items.find(row => row.kind === 'private').id;
  assert((await searchTool.action({ ...searchArgs, target: historyPrivateAlias })).isError);
  await controller.chatContext.sharing(who, '/context-sharing on');
  delete controller.searchHistory;
  // Accepted bot replies retain direction and actual image bytes; menus/errors
  // are not archived, rejected sends never become history, and save failures
  // cannot turn platform acceptance into an apparent transport failure.
  let rejected = false; let historyBroken = false; const historyNotices = [];
  const delivery = new ChatDelivery({ transport: async (_target, _content, { beforeCommit }) => {
    await beforeCommit();
    if (rejected) throw new Error('FIXTURE_SEND_FAILED'); return { id: 'fixture-accepted' };
  }, diagnostics: new DeliveryDiagnostics(), onState() {},
  assertCanContinue: async () => {}, notifyAdmins: async report => historyNotices.push(report),
  rememberReply: async (scope, content, result) => {
    if (historyBroken) throw new Error('FIXTURE_SAVE_FAILED');
    await controller.messageRecords.captureReply(scope, content, result);
  } });
  await delivery.send('group:target', 'assistant prior answer', { history: true });
  await delivery.send('group:target', 'operator menu');
  rejected = true;
  await assert.rejects(delivery.send('group:target', 'REJECTED_TEXT', { history: true }), /FIXTURE_SEND_FAILED/);
  rejected = false; historyBroken = true;
  await delivery.send('group:target', 'accepted despite local archive failure', { history: true });
  assert.equal(historyNotices[0].reason, 'REPLY_HISTORY_FAILED');
  historyBroken = false;
  const jpeg = Buffer.from([255, 216, 255, 0]);
  const botImage = await controller.messageRecords.captureReply('group:target', { media: { type: 'image', bytes: jpeg } }, { id: 'fixture-image' });
  const history = await session(request('read', { target: alias }));
  assert(history.items.some(row => row.speaker?.role === 'assistant' && row.components.some(c => c.text === 'assistant prior answer')));
  assert(!JSON.stringify(history).includes('operator menu')); assert(!JSON.stringify(history).includes('REJECTED_TEXT'));
  const contextAccess = new ContextAccess({ scope: source, store, eventSocket: bridge.path });
  const register = toolRegistrar({ registerTool(name, options, action) { tools.set(name, { options, action }); } }, toolPolicy());
  const mediaContext = { scope: source, store, records: controller.messageRecords, messageImages: controller.messageImages, contextAccess };
  closeMessages = registerMessageTools(register, mediaContext);
  registerMessageImageTools(register, mediaContext);
  const detail = await tools.get('get_message_detail').action({ turn_id: turnId, context_chat: alias, id: botImage.messageId, include_images: true });
  assert(!detail.isError); assert(detail.content.some(block => block.type === 'image' && block.data === jpeg.toString('base64')));
  assert(!JSON.stringify(detail).includes('SPEAKER_ID_SENTINEL'));
  // Forward acquisition shares the same turn-local target grant, including
  // revocation during the asynchronous gateway call and private sharing changes.
  const forwardId = 'forward:' + 'f'.repeat(32); let forwardScope;
  controller.readForward = async (scope, id, check) => { await check(); assert.equal(id, forwardId); forwardScope = scope; return { acquired: true }; };
  await contextAccess.expandForward({ id: forwardId, turn_id: turnId, context_chat: alias });
  assert.equal(forwardScope, 'group:target');
  await assert.rejects(contextAccess.expandForward({ id: forwardId, turn_id: randomUUID(), context_chat: alias }), /REPLY_TURN_EXPIRED/);
  await assert.rejects(contextAccess.expandForward({ id: forwardId, turn_id: turnId, context_chat: 'chat:' + randomUUID() }), /CONTEXT_TARGET_UNAVAILABLE/);
  controller.readForward = async (_scope, _id, check) => {
    await check(); await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = false; });
    await check(); return { acquired: true };
  };
  await assert.rejects(contextAccess.expandForward({ id: forwardId, turn_id: turnId, context_chat: alias }), /CONTEXT_TARGET_UNAVAILABLE/);
  await controller.groupAccess.update(scopeId('group:target'), row => { row.listen = true; });
  const privateForwardAlias = (await session(request('list'))).items.find(row => row.kind === 'private').id;
  controller.readForward = async (_scope, _id, check) => {
    await check(); await controller.chatContext.sharing(who, '/context-sharing off'); await check();
  };
  await assert.rejects(contextAccess.expandForward({ id: forwardId, turn_id: turnId, context_chat: privateForwardAlias }), /CONTEXT_NOT_SHARED/);
  await controller.chatContext.sharing(who, '/context-sharing on');
  delete controller.readForward;
  // Identity filtering precedes raw content pagination, including later pages.
  const sharedLong = { ...message('group', 'target', 'long body '.repeat(2500)), senderId: 'SPEAKER_ID_SENTINEL',
    mentions: [{ member_openid: 'MENTION_ID_SENTINEL', nickname: 'untrusted label' }] };
  await controller.messageRecords.capture('group:target', sharedLong, null, true);
  let sharedJSON = '', sharedOffset = 0;
  do {
    const result = await tools.get('get_message_detail').action({ turn_id: turnId, context_chat: alias,
      id: sharedLong.messageId, content_offset: sharedOffset, content_limit: 1000, include_images: false });
    assert(!result.isError);
    assert(!JSON.stringify(result).includes('SPEAKER_ID_SENTINEL'));
    assert(!JSON.stringify(result).includes('MENTION_ID_SENTINEL'));
    const page = JSON.parse(result.content[0].text).contentPage;
    sharedJSON += page.text; sharedOffset = page.nextOffset;
  } while (sharedOffset !== null);
  assert.equal(JSON.parse(sharedJSON).components.find(c => c.type === 'text').text, sharedLong.content);
  // Shared metadata-only attachments are present even when there is no text.
  const fileMessage = { ...message('group', 'target', ''), attachments: [{ content_type: 'file', filename: 'fixture.txt', url: 'https://multimedia.nt.qq.com.cn/fixture' }] };
  await controller.messageRecords.capture('group:target', fileMessage, null, true);
  assert((await session(request('read', { target: alias }))).items.some(row => row.components.some(c => c.type === 'file')));
  const fileRecord = await controller.messageRecords.find('group:target', fileMessage.messageId);
  let downloaded = false;
  const selectedFiles = new Files({ ...mediaContext, downloadQQ: async (_url, _limit, { consume }) => {
    downloaded = true; return consume([Buffer.from('shared attachment contents')]);
  } });
  await selectedFiles.save({ name: 'shared.txt', area: 'workspace', format: 'original',
    attachment_id: fileRecord.components.find(c => c.type === 'file').id, context_chat: alias, turn_id: turnId });
  assert(downloaded);
  assert.equal(await selectedFiles.workspace.readText('shared.txt'), 'shared attachment contents');
  const voice = { ...message('group', 'target', ''), attachments: [{ content_type: 'voice', filename: 'fixture.silk',
    url: 'https://multimedia.nt.qq.com.cn/voice-fixture', asr_refer_text: 'delivered voice reference' }] };
  const voiceRecord = await controller.messageRecords.capture('group:target', voice, null, true);
  const audioDetail = await tools.get('get_audio_detail').action({ context_chat: alias, turn_id: turnId,
    id: voiceRecord.components.find(c => c.type === 'audio').id, method: 'qq' });
  assert(!audioDetail.isError); assert(JSON.stringify(audioDetail).includes('delivered voice reference'));
  const gifRecord = await controller.messageRecords.captureReply('group:target', { media: { type: 'image', bytes: Buffer.from('GIF89afixture') } }, { id: 'fixture-gif' });
  const sharedMedia = new MessageMedia({ ...mediaContext, images: controller.messageImages, eventSocket: bridge.path,
    watch: async () => ({ check: async () => {}, assertActive() {}, notify: async () => {}, close: async () => {} }),
    decoder: { open: async () => ({ metadata: { duration: 1 }, stream: async function* () {
      yield { bytes: jpeg, mimeType: 'image/jpeg', timestamp: 0 };
    }, close: async () => {} }) } });
  let sharedMediaId;
  try {
    await sharedMedia.read({ turn_id: turnId, context_chat: alias, image_id: gifRecord.components[0].imageId, timestamps: [0] });
    const opened = [...sharedMedia.sessions.values()][0]; sharedMediaId = opened.id;
    await Promise.all([...opened.queries.values()].map(q => q.task));
    assert.equal([...opened.queries.values()][0].status, 'ready');
    await controller.groupAccess.update(scopeId('group:target'), group => { group.listen = false; });
    await assert.rejects(sharedMedia.read({ turn_id: turnId, media_id: sharedMediaId, timestamps: [0] }), /CONTEXT_TARGET_UNAVAILABLE/);
  } finally { await sharedMedia.close(); }
  await controller.groupAccess.update(scopeId('group:target'), group => { group.listen = false; });
  const revoked = await tools.get('get_image_detail').action({ turn_id: turnId, context_chat: alias, image_ids: [botImage.components[0].imageId] });
  assert.equal(revoked.isError, true); assert(!revoked.content.some(block => block.type === 'image'));
  assert.equal(await selectedFiles.workspace.readText('shared.txt'), 'shared attachment contents'); // Explicit independent copy.
  await controller.groupAccess.update(scopeId('group:target'), group => { group.listen = true; });
  assert.equal((await callReplyBridge(bridge.path, { action: 'chat_context', turn_id: randomUUID(), ...request('list') })).code, 'REPLY_TURN_EXPIRED');
  await binding.close();
  const discovery = bridge.bind({ id: randomUUID() });
  assert.throws(() => bridge.dispatch({ turn_id: discovery.turn.id, action: 'chat_context', ...request('list') }), /TURN_ACTION_NOT_ALLOWED/);
  await discovery.close();
  // Controller only supplies the capability to authorized foreground/batch turns.
  inspectRun = async options => { assert.equal(typeof options.onChatContext, 'function'); await options.onChatContext(request('list')); };
  await controller.run('c2c:operator', 'fixture', {}, { onReply: async () => {} });
  inspectRun = async options => {
    assert.equal(typeof options.onChatContext, 'function');
    await controller.groupAccess.update(scopeId(source), row => { row.engage = false; });
    await assert.rejects(options.onChatContext(request('list')), /CONTEXT_SOURCE_UNAVAILABLE/);
  };
  await controller.run(source, 'fixture', {}, { background: true, purpose: 'batch', onReply: async () => {} });
  await controller.groupAccess.update(scopeId(source), row => { row.engage = true; });
  inspectRun = async options => { assert.equal(options.onChatContext, undefined); };
  await controller.run('c2c:operator', 'fixture', {}, { background: true, purpose: 'discover' });
  await controller.run(source, 'fixture', {}, { background: true, purpose: 'warmup', onReply: async () => {} });
  // Text budgets paginate instead of expanding media/forwarded components.
  for (let i = 0; i < 15; i++) await controller.messageRecords.capture('c2c:person', message('c2c', 'person', 'x'.repeat(1200)), false);
  const bounded = await controller.messageRecords.contextPage('c2c:person', {});
  assert(bounded.items.length < 15); assert(bounded.nextOffset > 0);
  assert(JSON.stringify(bounded).length < 12500);
  const next = await controller.messageRecords.contextPage('c2c:person', { offset: bounded.nextOffset });
  assert(next.items.length > 0); assert(!bounded.items.some(row => next.items.some(other => other.id === row.id)));
  await controller.replyContacts.block('c2c:person');
  assert(!(await session(request('list'))).items.some(row => row.kind === 'private'));
  await controller.replyContacts.observe(privateMessage);
  const readerForFailure = controller.chatContext.session(source, check, 'fixture-failure');
  const failureAlias = (await readerForFailure(request('list'))).items.find(row => row.kind === 'group').id;
  const notifications = []; controller.notifyAdmins = async report => notifications.push(report);
  controller.messageRecords.contextPage = async () => { throw new Error('PRIVATE_DATABASE_BODY_SENTINEL'); };
  await assert.rejects(readerForFailure(request('read', { target: failureAlias })), /CHAT_CONTEXT_FAILED/);
  assert.equal(notifications[0].reason, 'CHAT_CONTEXT_FAILED');
  assert.equal(controller.debug.read(source).counters.chat_context_failed, 1);
  assert(!JSON.stringify(controller.debug.read(source)).includes('PRIVATE_DATABASE_BODY_SENTINEL'));
  controller.messageRecords.contextPage = originalPage;
  const persisted = await controller.adminSettings.read('c2c:person');
  const restarted = new (controller.adminSettings.constructor)(store);
  assert.deepEqual(await restarted.read('c2c:person'), persisted);
  assert(!JSON.stringify(controller.debug.read(source)).includes('PRIVATE_TEXT_FIXTURE'));
  console.log('Offline cross-chat context checks passed: opt-in sharing, structured records, accepted reply history/images, source/target revocation, scoped media access, unchanged receipts and discovery exclusion.');
} finally { await closeMessages?.(); await bridge?.close(); await controller?.close(); await rm(root, { recursive: true, force: true }); }
