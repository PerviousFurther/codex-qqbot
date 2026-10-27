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
  closeTools = registerMessageTools(register, { scope, store, messageImages: images });
  registerMessageImageTools(register, { scope, store, messageImages: images });
  const detail = args => tools.get('get_message_detail').action(tools.get('get_message_detail').schema.parse(args));
  const forwarded = await records.capture(scope, incoming('root', { msgType: 102, msgElements: [{ message_type: 102, content: 'container',
    msg_elements: [{ content: 'inner image message', attachments: [attachment(1), { content_type: 'voice',
      url: 'https://gchat.qpic.cn/audio', asr_refer_text: 'unverified ASR' }, { content_type: 'video/mp4', url: 'https://gchat.qpic.cn/video' }] }] }] }), null, true);
  let result = await detail({ id: forwarded.messageId });
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
  await records.capture(scope, incoming('expired', { attachments: [attachment('expired')] }), null, true);
  result = await detail({ id: 'expired' });
  assert.equal(result.isError, undefined); assert.equal(result.content.filter(block => block.type === 'image').length, 0);
  assert.equal(JSON.parse(result.content[1].text).error, 'IMAGE_UNAVAILABLE_OR_EXPIRED');
  assert(page(result).message.messageId === 'expired'); // Image failure does not erase retained text.

  // Another scope cannot follow a message or image ID from this conversation.
  const otherTools = new Map();
  closeOther = registerMessageTools(toolRegistrar({ registerTool(name, _options, action) { otherTools.set(name, action); } },
    { get_message_detail: {}, get_audio_detail: {} }), { scope: 'group:other', store, messageImages: images });
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
