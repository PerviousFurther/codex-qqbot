import { snowMessage } from '../lib/snowluma-messages.mjs';
// Offline: synthetic nested messages, disposable SQLite and fake QQ image bytes only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { MessageImages } from '../lib/message-images.mjs';
import { MessageRecords } from '../lib/message-records.mjs';
import { registerMessageTools } from '../lib/tools/messages.mjs';
import { registerMessageImageTools } from '../lib/tools/message-images.mjs';
import { toolRegistrar } from '../lib/tools/register.mjs';
import { scopeId } from '../lib/policy.mjs';
import { z } from 'zod';
import { normalizeQQMessage } from '../lib/message-elements.mjs';
import { SnowLumaForwards } from '../lib/snowluma-forwards.mjs';
import { ChatContext } from '../lib/chat-context.mjs';
import { ContextAccess } from '../lib/context-access.mjs';
import { ReplyBridge } from '../lib/reply-bridge.mjs';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'watch-message-images-'));
const store = new Store(root), images = new MessageImages(store), records = new MessageRecords(store, images);
const scope = 'group:fixture'; const groupPath = join(root, 'groups', scopeId(scope) + '.json');
const originalFetch = globalThis.fetch;
let closeTools; let closeOther; let fetches = []; let duringFetch = null;
const pixels = Buffer.from([255, 216, 255, 0]);
const attachment = index => ({ content_type: 'image/jpeg', url: `https://gchat.qpic.cn/fixture-${index}?token=PRIVATE_TOKEN` });
const incoming = (messageId, extra = {}) => ({ kind: 'group', groupOpenid: 'fixture', senderId: 'member', messageId, content: '', ...extra });
const page = result => JSON.parse(result.content[0].text);
try {
  await store.write(groupPath, { allowed: true, listen: true });
  globalThis.fetch = async url => {
    fetches.push(String(url)); await duringFetch?.();
    if (String(url).includes('expired')) return new Response('', { status: 404 });
    return new Response(pixels, { headers: { 'content-type': 'image/jpeg' } });
  };
  const tools = new Map();
  const register = toolRegistrar({ registerTool(name, options, action) { tools.set(name, { schema: z.object(options.inputSchema), action }); } },
    { get_message_detail: {}, get_audio_detail: {}, get_image_detail: {} });
  closeTools = registerMessageTools(register, { scope, store, records, messageImages: images });
  registerMessageImageTools(register, { scope, store, messageImages: images });
  const detail = args => tools.get('get_message_detail').action(tools.get('get_message_detail').schema.parse(args));
  // OneBot descriptors and nested image segments use the real detail pixel boundary.
  const onebot = await snowMessage({ post_type: 'message', message_type: 'group', self_id: 123456, user_id: 654321,
    group_id: 777777, message_id: 99, time: Date.now()/1000, message: [
      {type:'text',data:{text:'[附件1] 类型:图片 文件名:fixture.jpg 尺寸:10x10 大小:1KB URL:https://gchat.qpic.cn/snow-text?token=PRIVATE_TOKEN'}},
      {type:'node',data:{content:[{type:'image',data:{url:'https://gchat.qpic.cn/snow-nested?token=PRIVATE_TOKEN',file:'nested.jpg'}}]}}
    ] }, '123456');
  // Use this fixture's authorized scope; identity normalization is checked separately.
  onebot.groupOpenid = 'fixture';
  await records.capture(scope,onebot,null,true);
  const snowPixels = await detail({id:onebot.messageId});
  assert.equal(snowPixels.content.filter(item=>item.type==='image').length,2);
  for(const pixel of snowPixels.content.filter(item=>item.type==='image')) assert.equal(pixel.data,pixels.toString('base64'));
  assert(!JSON.stringify(snowPixels).includes('PRIVATE_TOKEN'));
  assert(!JSON.stringify(snowPixels).includes('gchat.qpic.cn'));

  // Explicit forward acquisition traverses the real IPC and tool boundary.
  // No SDK network calls: all returned nodes and pixels are synthetic.
  {
    const snowScope = 'group:sl~123456~777777';
    const path = join(root, 'groups', scopeId(snowScope) + '.json');
    await store.write(path, { allowed: true, listen: true });
    const calls = []; let duringRead; let active = true;
    const c = { messageRecords: records, groupAccess: { read: () => store.read(path) },
      debug: { record() {} }, notifyAdmins: async () => {} };
    const channel = { controller: c, account: '123456', ready: true, accepting: true, generation: 0,
      client: { getForwardMessage: async ({ id }, options) => {
        assert.equal(options.timeoutMs, 15000); calls.push(id); await duringRead?.(options);
        return { messages: [{ sender: { user_id: 654321, nickname: 'untrusted' }, time: 1700000000,
          message: [{ type: 'text', data: { text: `BODY_${id === 'PRIVATE_NESTED_KEY' ? 'NESTED' : 'FIRST'}` } },
            { type: 'image', data: { url: 'https://gchat.qpic.cn/forward-pixel?token=PRIVATE_TOKEN' } },
            ...(id === 'PRIVATE_NESTED_KEY' ? [] : [{ type: 'forward', data: { id: 'PRIVATE_NESTED_KEY' } }]),
            { type: 'reply', data: { message: [{ type: 'text', data: { text: 'delivered quote' } }] } }] },
          { message: [{ type: 'text', data: { text: 'no invented sender or time' } }] }] };
      } } };
    const acquisition = new SnowLumaForwards(channel);
    c.readForward = (...args) => acquisition.read(...args);
    const bridge = await ReplyBridge.open(); const turnId = randomUUID();
    const session = new ChatContext(c).session(snowScope, async () => {
      if (!active) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
    });
    const binding = bridge.bind({ id: turnId, chatContext: session });
    const forwardTools = new Map();
    const registerForward = toolRegistrar({ registerTool(name, options, action) {
      forwardTools.set(name, { schema: z.object(options.inputSchema), action });
    } }, { get_message_detail: {}, get_audio_detail: {} });
    const close = registerMessageTools(registerForward, { scope: snowScope, store, records, messageImages: images,
      contextAccess: new ContextAccess({ scope: snowScope, store, eventSocket: bridge.path }) });
    const read = args => forwardTools.get('get_message_detail').action(forwardTools.get('get_message_detail').schema.parse({ turn_id: turnId, ...args }));
    let nextId = 200;
    const receive = async () => {
      const incoming = await snowMessage({ post_type: 'message', message_type: 'group', self_id: 123456,
        user_id: 654321, group_id: 777777, message_id: nextId++, message: [{ type: 'forward', data: { id: 'PRIVATE_ROOT_KEY' } }] }, '123456');
      const record = await records.capture(snowScope, incoming, null, true);
      return { parent: record.messageId, id: record.components[0].messageId };
    };
    try {
      const first = await receive();
      assert.equal(calls.length, 0);
      const parentPage = await read({ id: first.parent, include_images: false });
      assert.equal(calls.length, 0); assert(!JSON.stringify(parentPage).includes('PRIVATE_ROOT_KEY'));
      const beforePixels = fetches.length;
      let result = await read({ id: first.id, include_images: false });
      assert(!result.isError, JSON.stringify(result));
      assert.deepEqual(calls, ['PRIVATE_ROOT_KEY']); assert.equal(fetches.length, beforePixels);
      const forwardPage = page(result);
      assert.equal(forwardPage.items.length, 2);
      assert(!forwardPage.message.speaker); assert(!forwardPage.message.timestamp);
      assert.equal(forwardPage.items[1].speaker.openid, null); assert.equal(forwardPage.items[1].timestamp, null);
      assert(!JSON.stringify(result).includes('PRIVATE_ROOT_KEY')); assert(!JSON.stringify(result).includes('PRIVATE_NESTED_KEY'));
      assert(!JSON.stringify(result).includes('gchat.qpic.cn')); assert(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
      const childId = forwardPage.items[0].messageId;
      result = await read({ id: childId });
      assert(result.content.some(block => block.type === 'image' && block.data === pixels.toString('base64')));
      assert(JSON.stringify(result).includes('delivered quote')); assert.equal(calls.length, 1);
      const nested = page(result).message.components.find(part => part.type === 'record_ref' && part.relation === 'forwarded');
      assert(nested); assert(!('components' in nested));
      result = await read({ id: nested.messageId, include_images: false });
      assert(JSON.stringify(result).includes('BODY_NESTED')); assert.equal(calls.length, 2);
      await read({ id: first.id, include_images: false }); assert.equal(calls.length, 2); // Cached; no repeat acquisition.
      const originalLeaf = (await records.find(snowScope, first.parent)).components[0];
      assert.equal(originalLeaf.type, 'record_ref'); assert(!('components' in originalLeaf));
      assert(!(await records.contextPage(snowScope, {})).items.some(row => row.id === first.id || row.id === childId));
      const db = await records.database(snowScope);
      assert.equal(db.prepare('SELECT received FROM records WHERE id=?').get(childId).received,
        db.prepare('SELECT received FROM records WHERE id=?').get(first.parent).received);
      // Invalid turns and missing/old acquisition keys never reach the SDK.
      let next = await receive();
      assert.equal(page(await read({ id: next.id, turn_id: randomUUID() })).code, 'REPLY_TURN_EXPIRED');
      assert.equal(page(await read({ id: 'forward:' + 'a'.repeat(32) })).code, 'FORWARD_REFERENCE_UNAVAILABLE');
      assert.equal(calls.length, 2);
      duringRead = async () => store.write(path, { allowed: true, listen: false });
      result = await read({ id: next.id });
      assert(result.isError); assert(!await records.find(snowScope, next.id));
      await store.write(path, { allowed: true, listen: true });
      duringRead = async () => { channel.generation++; };
      result = await read({ id: next.id });
      assert.equal(page(result).code, 'SNOWLUMA_CONNECTION_UNAVAILABLE');
      assert(!await records.find(snowScope, next.id));
      duringRead = async () => { active = false; };
      result = await read({ id: next.id });
      assert.equal(page(result).code, 'CONTEXT_SOURCE_UNAVAILABLE'); assert(!await records.find(snowScope, next.id));
      active = true;
      duringRead = async () => records.clear(snowScope);
      result = await read({ id: next.id });
      assert.equal(page(result).code, 'MESSAGE_NOT_RETAINED'); assert(!await records.find(snowScope, next.id));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM forward_refs').get().n, 0);
      duringRead = null;
      next = await receive();
      db.prepare('UPDATE records SET received=? WHERE id=?').run(Date.now() - 8 * 86400000, next.parent);
      const beforeExpired = calls.length;
      assert.equal(page(await read({ id: next.id })).code, 'FORWARD_REFERENCE_UNAVAILABLE'); assert.equal(calls.length, beforeExpired);
      await assert.rejects(acquisition.read('group:sl~999999~777777', next.id, async () => {}), /SNOWLUMA_TARGET_MISMATCH/);
      next = await receive();
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      duringRead = async ({ signal }) => { entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); };
      const pendingRead = read({ id: next.id });
      await started; await binding.close();
      result = await pendingRead;
      assert(result.isError); assert(!await records.find(snowScope, next.id));
    } finally { await close(); await binding.close(); await bridge.close(); }
  }

  // Observed QQ forward shape: pictures are explicit descriptors in content,
  // with no attachment array or delivered inner-message tree. Preserve those
  // actual pointers before normalization hides URLs, without fabricating nodes.
  const textualUrl = 'https://gchat.qpic.cn/textual-fixture?rkey=PRIVATE_TEXTUAL_TOKEN';
  const descriptor = `[群聊的聊天记录]\n=== 消息 1 ===\n[附件1] 类型:图片 文件名:fixture.png 尺寸:1428x885 大小:251.3KB URL:${textualUrl}`;
  const textual = incoming('textual-forward', { msgType: 102, content: descriptor });
  normalizeQQMessage(textual); normalizeQQMessage(textual);
  assert.equal(textual.attachments.length, 1); assert(!textual.content.includes('PRIVATE_TEXTUAL_TOKEN'));
  let beforeTextual = fetches.length;
  await records.capture(scope, textual, null, true);
  assert.equal(fetches.length, beforeTextual); // Capture indexes, never downloads.
  let textualResult = await detail({ id: textual.messageId });
  assert.equal(textualResult.content.filter(block => block.type === 'image').length, 1);
  assert.equal(textualResult.content.find(block => block.type === 'image').data, pixels.toString('base64'));
  const textualRecord = page(textualResult).message;
  const textualImage = textualRecord.components.find(c => c.type === 'image');
  assert.equal(textualImage.source, 'qq_textual_attachment'); assert.equal(textualImage.untrusted, true);
  assert.equal((await records.attachment(scope, textualImage.id)).url, textualUrl);
  assert(!JSON.stringify(textualResult).includes('PRIVATE_TEXTUAL_TOKEN'));
  assert.equal(textualRecord.components.find(c => c.relation === 'forwarded').status, 'BODY_NOT_DELIVERED');
  assert.equal(page(textualResult).items.length, 0); // No guessed speaker/time/tree.
  beforeTextual = fetches.length;
  textualResult = await detail({ id: textual.messageId, include_images: false });
  assert.equal(fetches.length, beforeTextual); assert(!textualResult.content.some(c => c.type === 'image'));
  for (const type of [102, 103]) {
    await records.capture(scope, incoming(`textual-nested-${type}`, { msgType: type,
      msgElements: [{ content: descriptor }] }), null, true);
    textualResult = await detail({ id: `textual-nested-${type}` });
    assert.equal(textualResult.content.filter(block => block.type === 'image').length, 1);
    assert.equal(page(textualResult).items.length, 1);
    assert(page(textualResult).items[0].components.some(c => c.type === 'image' && c.imageId));
    assert(!JSON.stringify(textualResult).includes('PRIVATE_TEXTUAL_TOKEN'));
  }
  const duplicate = incoming('textual-duplicate', { content: descriptor,
    attachments: [{ content_type: 'image/png', url: textualUrl }] });
  normalizeQQMessage(duplicate); assert.equal(duplicate.attachments.length, 1);
  for (const url of ['https://example.com/image.png', 'http://gchat.qpic.cn/image.png',
    'https://user:password@gchat.qpic.cn/image.png', 'https://gchat.qpic.cn:8443/image.png']) {
    const rejected = incoming('unsupported-textual', { content: descriptor.replace(textualUrl, url) });
    normalizeQQMessage(rejected); assert.equal(rejected.attachments.length, 0);
  }
  const incomplete = incoming('incomplete-textual', { content: `[附件1] URL:${textualUrl}` });
  normalizeQQMessage(incomplete); assert.equal(incomplete.attachments.length, 0);
  fetches = [];
  const forwarded = await records.capture(scope, incoming('root', { msgType: 102, msgElements: [{ message_type: 102, content: 'container',
    msg_elements: [{ content: 'inner image message', attachments: [attachment(1), { content_type: 'voice',
      url: 'https://gchat.qpic.cn/audio', asr_refer_text: 'unverified ASR' }, { content_type: 'video/mp4', url: 'https://gchat.qpic.cn/video' }] }] }] }), null, true);
  const containerId = forwarded.components.find(c => c.relation === 'forwarded').components[0].messageId;
  const containerRecord = await records.find(scope, containerId);
  const deepRef = containerRecord.components.find(c => c.relation === 'forwarded').components[0];
  assert.equal(deepRef.type, 'record_ref'); assert(!('components' in deepRef));
  const originalFind = records.find; const requested = [];
  records.find = async function(readScope, id) { requested.push(id); return originalFind.call(this, readScope, id); };
  let result;
  try { result = await detail({ id: forwarded.messageId }); }
  finally { records.find = originalFind; }
  assert(!requested.includes(deepRef.messageId)); // Never dereference grandchildren automatically.
  assert.equal(result.content.filter(block => block.type === 'image').length, 0); assert.equal(fetches.length, 0);
  assert(!JSON.stringify(result).includes('inner image message')); // No hidden deep expansion.
  const nestedId = page(result).items[0].messageId;
  result = await detail({ id: nestedId });
  assert.equal(result.isError, undefined); assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  assert.equal(result.content.find(block => block.type === 'image').data, pixels.toString('base64'));
  const inner = page(result).items[0]; const media = inner.components.filter(item => ['image', 'audio', 'video'].includes(item.type)); const imageId = media[0].imageId;
  assert.equal(media[0].detailTool, 'get_image_detail');
  assert.equal(media[1].detailTool, 'get_audio_detail'); assert.equal(media[2].detailTool, 'read_media');
  assert.deepEqual(page(result).imagePreviews.requestedImageIds, [imageId]);
  const provenance = JSON.parse(result.content[1].text).source;
  assert.equal(provenance.imageId, imageId); assert.equal(provenance.messageId, inner.messageId);
  assert.equal(provenance.embedded, true); assert.equal(provenance.identityVerified, false);
  assert(!JSON.stringify(result).includes('PRIVATE_TOKEN')); assert.equal(fetches.length, 1);
  const beforeTextOnly = fetches.length;
  result = await detail({ id: nestedId, include_images: false });
  assert.equal(result.content.length, 1); assert.equal(fetches.length, beforeTextOnly);
  assert.equal(page(result).imagePreviews.remainingCount, 1);
  result = await tools.get('get_image_detail').action({ image_ids: [imageId] });
  assert.equal(result.content.filter(block => block.type === 'image').length, 1);

  await records.capture(scope, incoming('many', { msgType: 102,
    msgElements: Array.from({ length: 4 }, (_, index) => ({ content: 'child ' + index, attachments: [attachment(index)] })) }), null, true);
  let before = fetches.length; result = await detail({ id: 'many' });
  assert.equal(fetches.length - before, 3); assert.equal(result.content.filter(block => block.type === 'image').length, 3);
  assert.equal(page(result).imagePreviews.remainingCount, 1);
  result = await detail({ id: 'many', limit: 1 }); assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  assert.equal(page(result).nextOffset, 1);
  result = await detail({ id: 'many', offset: 3 }); assert.equal(result.content.filter(block => block.type === 'image').length, 1);

  await records.capture(scope, incoming('quote', { msgType: 103, refMsgIdx: inner.messageId }), null, true);
  result = await detail({ id: 'quote' }); assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  // Real tool output follows nested quote references with the same rules as
  // top-level replies; neither implicit deep pixels nor duplicate copies.
  for (const [name, reference] of Object.entries({
    reference: { message_reference: { message_id: inner.messageId } },
    scene: { message_scene: { ext: [`ref_msg_idx=${inner.messageId}`] } },
  })) {
    await records.capture(scope, incoming(`nested-quote-${name}`, { msgType: 102,
      msgElements: [{ ...reference, message_type: 103, content: 'quoted image' }] }), null, true);
    result = await detail({ id: `nested-quote-${name}` });
    assert.equal(result.content.filter(block => block.type === 'image').length, 0);
    const quoted = page(result).items[0];
    assert.deepEqual(quoted.components.filter(c => c.type === 'record_ref').map(c => c.relation), ['quote']);
    result = await detail({ id: quoted.messageId });
    assert.equal(result.content.filter(block => block.type === 'image').length, 1);
    assert.equal(page(result).items[0].messageId, inner.messageId);
  }
  await records.capture(scope, incoming('snapshot-quote', { msgType: 103, refMsgIdx: inner.messageId,
    msgElements: [{ message_type: 103, msg_idx: inner.messageId, content: 'snapshot', attachments: [attachment('snapshot')] }] }), null, true);
  result = await detail({ id: 'snapshot-quote' });
  assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  assert.equal(page(result).items.length, 1);
  assert.deepEqual(page(result).message.components.filter(c => c.type === 'record').map(c => c.relation), ['quote']);
  assert(!page(result).items[0].components.some(c => c.relation === 'quote'));
  await records.capture(scope, incoming('expired', { attachments: [attachment('expired')] }), null, true);
  result = await detail({ id: 'expired' });
  assert.equal(result.isError, undefined); assert.equal(result.content.filter(block => block.type === 'image').length, 0);
  assert.equal(JSON.parse(result.content[1].text).error, 'IMAGE_UNAVAILABLE_OR_EXPIRED');
  assert(page(result).message.messageId === 'expired'); // Image failure does not erase retained text.

  // Another scope cannot follow a message or image ID from this conversation.
  const otherTools = new Map();
  closeOther = registerMessageTools(toolRegistrar({ registerTool(name, _options, action) { otherTools.set(name, action); } },
    { get_message_detail: {}, get_audio_detail: {} }), { scope: 'group:other', store, records, messageImages: images });
  await store.write(join(root, 'groups', scopeId('group:other') + '.json'), { allowed: true, listen: true });
  result = await otherTools.get('get_message_detail')({ id: inner.messageId });
  assert.equal(result.isError, true); assert.equal(page(result).code, 'MESSAGE_NOT_RETAINED');
  // A download racing permission revocation must return neither buffered text nor pixels.
  duringFetch = async () => { await store.write(groupPath, { allowed: true, listen: false }); };
  result = await detail({ id: nestedId });
  assert.equal(result.isError, true); assert.equal(page(result).code, 'GROUP_MESSAGES_DISABLED');
  assert(!JSON.stringify(result).includes('inner image message')); assert(!result.content.some(block => block.type === 'image'));
  // Record clearing while pixels are being acquired is checked after download too.
  await store.write(groupPath, { allowed: true, listen: true });
  duringFetch = async () => records.clear(scope);
  result = await detail({ id: nestedId });
  assert.equal(result.isError, true); assert.equal(page(result).code, 'MESSAGE_NOT_RETAINED');
  assert(!result.content.some(block => block.type === 'image'));
  console.log('Offline message-detail checks passed: nested/quoted pixels, shallow paging, text-only opt-out, image cap/provenance, mixed attachments, explicit expiry and revocation/retention guards.');
} finally {
  globalThis.fetch = originalFetch;
  await closeOther?.(); await closeTools?.(); await records.close(); await images.close();
  await rm(root, { recursive: true, force: true });
}
