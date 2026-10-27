import { recordComponents } from '../lib/record.mjs';
import { agentInput } from '../lib/agent-input.mjs';
// Offline integration checks: synthetic messages and temporary SQLite only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentCodecs, contentCodecs } from '../lib/content-codecs.mjs';
import '../lib/message-codecs.mjs';
import { toolRegistrar } from '../lib/tools/register.mjs';
import { MessageRecords } from '../lib/message-records.mjs';
import { MessageImages } from '../lib/message-images.mjs';
import { GroupContext } from '../lib/group-context.mjs';
import { ForegroundRequests } from '../lib/foreground-requests.mjs';
import { Store } from '../lib/store.mjs';
import { registerMessageTools } from '../lib/tools/messages.mjs';
import { toolApprovals } from '../lib/tool-policy.mjs';
import { assertMessageAccess } from '../lib/message-access.mjs';
import { scopeId } from '../lib/policy.mjs';
import { messageCard, normalizeQQText } from '../lib/message-elements.mjs';
import { z } from 'zod';

const media = record => record.components.filter(item => ['image', 'audio', 'video', 'file'].includes(item.type));
const forward = record => record.components.find(item => item.relation === 'forwarded');
const body = record => record.components.filter(item => item.type === 'text').map(item => item.text).join('');

const root = await mkdtemp(join(tmpdir(), 'watch-content-check-'));
const store = new Store(root), images = new MessageImages(store);
const records = new MessageRecords(store, images), groups = new GroupContext(store);
let closeTools;
const scope = 'c2c:fixture';
const incoming = (messageId, extra = {}) => ({ kind: 'c2c', senderId: 'fixture', messageId,
  timestamp: new Date().toISOString(), content: '', ...extra });
try {
  // Conversions can also be mounted on an ordinary program-to-program boundary.
  const codecs = new ContentCodecs().register('bytes', 'text', value => value.toString('utf8'));
  assert.equal(codecs.value('bytes', Buffer.from('你好')).to('text').single(), '你好');
  assert.throws(() => codecs.register('bytes', 'text', String), /DUPLICATE/);
  assert.throws(() => codecs.value('text', '').to('bytes'), /UNSUPPORTED/);
  assert.deepEqual(contentCodecs.value('json', { ok: true }).to('mcp.content').single(), [{ type: 'text', text: '{"ok":true}' }]);

  const card = await records.capture(scope, incoming('card', { msgType: 3,
    raw: { ark_data: { ark_name: 'video', fields: { title: '标题', desc: '平台说明', url: 'https://www.bilibili.com/video/BV1234567890' } } } }), false);
  const cardComponent = card.components.find(item => item.type === 'card');
  assert.equal(cardComponent.title, '标题'); assert.equal(cardComponent.description, '平台说明');
  assert.equal(cardComponent.url, 'https://www.bilibili.com/video/BV1234567890');
  assert.equal(card.type, 'record'); assert.equal(card.card, undefined);
  assert.deepEqual(contentCodecs.value('message.record', card).to('message.content').single(), card);
  const tokenCard = await records.capture(scope, incoming('token-card', { raw: { ark_data: {
    fields: { title: '标题', url: 'https://example.com/?token=fixture' } } } }), false);
  assert(!JSON.stringify(tokenCard).includes('https://'));

  // Mini-app destinations, alternate fields and empty/unsafe primary URLs.
  const miniRaw = { app: 'com.tencent.miniapp_01', meta: { detail_1: {
    title: 'Shared video', desc: 'Delivered description', preview: 'https://example.com/cover.png',
    qqdocurl: 'https://www.bilibili.com/video/BV1234567890',
  } } };
  const mini = await records.capture(scope, incoming('mini-card', { msgType: 3, raw: { ark_data: miniRaw } }), false);
  const miniCard = mini.components.find(item => item.type === 'card');
  assert.equal(miniCard.title, 'Shared video'); assert.equal(miniCard.description, 'Delivered description');
  assert.equal(miniCard.name, miniRaw.app);
  assert.deepEqual(miniCard.links, [miniRaw.meta.detail_1.qqdocurl]);
  assert.deepEqual((await records.detail(scope, mini.messageId)).message.components.find(item => item.type === 'card'), miniCard);
  assert.equal(messageCard({ raw: { ark_data: JSON.stringify(miniRaw) } }).url, miniCard.url);
  for (const primary of ['', 'javascript:alert(1)', 'https://example.com/?token=private']) {
    const fallback = messageCard({ raw: { ark_data: { fields: { url: primary, jump_url: 'https://example.com/page' } } } });
    assert.equal(fallback.url, 'https://example.com/page');
    assert.deepEqual(fallback.links, ['https://example.com/page']);
  }
  const previewOnly = messageCard({ raw: { ark_data: { meta: { detail_1: { preview: 'https://example.com/cover.png',
    image: { url: 'https://example.com/image.png' } } } } } });
  assert.equal(previewOnly.url, undefined); assert.equal(previewOnly.linkStatus, 'NO_USABLE_LINK');
  assert.equal(messageCard({ raw: { ark_data: '{invalid' } }), null);
  const cycleCard = { fields: { url: 'https://example.com/page' } }; cycleCard.meta = cycleCard;
  assert.equal(messageCard({ raw: { ark_data: cycleCard } }).url, 'https://example.com/page');
  const faceExt = Buffer.from(JSON.stringify({ text: '[满头问号]' })).toString('base64');
  assert.equal(normalizeQQText(`<faceType=4,faceId="",ext="${faceExt}">`), '［QQ表情: [满头问号]］');
  assert.equal(normalizeQQText('[<face,id=14/>]'), '［QQ表情:14］');

  const forwarded = await records.capture(scope, incoming('forwarded', { msgType: 102,
    msgElements: [{ message_type: 102, content: '嵌套容器', author: { user_openid: 'unverified' },
      msg_elements: [{ content: 'DEEP_BODY', attachments: [
        { content_type: 'image/png', url: 'https://example.com/picture?token=private' },
        { content_type: 'voice', url: 'https://example.com/audio?token=private', asr_refer_text: '平台语音文字' },
      ] }] }, { content: 'SECOND_BODY' }] }), false);
  assert(!JSON.stringify(contentCodecs.value('message.record', forwarded).to('message.content').single()).includes('BODY'));
  let page = await records.detail(scope, 'forwarded', { limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1);
  assert.equal(body(page.items[0]), '嵌套容器');
  assert(!JSON.stringify(page).includes('DEEP_BODY'));
  const nestedId = page.items[0].messageId;
  assert.equal(page.items[0].embedded.identityVerified, false);
  page = await records.detail(scope, nestedId);
  assert.equal(body(page.items[0]), 'DEEP_BODY');
  assert(media(page.items[0])[0].imageId);
  assert.equal(media(page.items[0])[1].transcript.text, '平台语音文字');
  assert(!JSON.stringify(page).includes('token=private'));
  assert((await records.attachment(scope, media(page.items[0])[1].id)).url.includes('token=private'));
  assert.equal(body((await records.detail(scope, 'forwarded', { offset: 1 })).items[0]), 'SECOND_BODY');
  assert.equal((await records.detail(scope, 'forwarded', { offset: 2 })).nextOffset, null);
  await assert.rejects(records.detail('c2c:other', 'forwarded'), /MESSAGE_NOT_RETAINED/);

  // The character budget paginates without losing or recursively reading nodes.
  const many = await records.capture(scope, incoming('many', { msgType: 102,
    msgElements: Array.from({ length: 30 }, (_, index) => ({ content: `${index}:` + '字'.repeat(1100) })) }), false);
  assert.equal(forward(many).status, 'TRUNCATED');
  const readIds = [];
  let offset = 0;
  do {
    const result = await records.detail(scope, 'many', { offset });
    assert(JSON.stringify(result).length <= 24000);
    assert(result.nextOffset === null || result.nextOffset > offset);
    readIds.push(...result.items.map(item => item.messageId));
    offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(readIds, forward(many).components.map(child => child.messageId));

  const cycle = { content: 'cycle', message_type: 102 };
  cycle.msg_elements = [cycle];
  const cyclic = await records.capture(scope, incoming('cycle', { msgType: 102, msgElements: [cycle] }), false);
  const cyclicDetail = await records.detail(scope, cyclic.messageId);
  assert.equal(cyclicDetail.items.length, 1);
  assert.equal(forward(cyclicDetail.items[0]).status, 'TRUNCATED');

  await records.capture(scope, incoming('original', { content: 'QUOTED_BODY', msgIdx: 'quote-index' }), false);
  const quote = await records.capture(scope, incoming('quote', { content: '当前问题', msgType: 103, refMsgIdx: 'quote-index' }), false);
  assert(!JSON.stringify(contentCodecs.value('message.record', quote).to('message.content').single()).includes('QUOTED_BODY'));
  assert.equal(body((await records.detail(scope, 'quote')).items[0]), 'QUOTED_BODY');
  const missing = await records.capture(scope, incoming('missing', { msgType: 102 }), false);
  assert.equal(forward(contentCodecs.value('message.record', missing).to('message.content').single()).status, 'BODY_NOT_DELIVERED');
  assert.deepEqual((await records.detail(scope, 'missing')).items, []);

  const noUrl = await records.capture(scope, incoming('audio-no-url', { attachments: [{ content_type: 'voice', asr_refer_text: 'new ASR' }] }), false);
  assert.equal((await records.attachmentDetail(scope, media(noUrl)[0].id)).attachment.transcript.text, 'new ASR');

  // The same component walker handles real nested records without inventing times.
  const nested = { type: 'record', components: [card, noUrl] };
  const encoded = contentCodecs.value('message.record', nested).to('message.content').single();
  assert.equal([...recordComponents(encoded)].find(item => item.type === 'audio').detailTool, 'get_audio_detail');
  for (const component of recordComponents(encoded)) if (component.type !== 'record') {
    assert.equal(component.timestamp, undefined); assert.equal(component.speaker, undefined);
  }
  const longText = 'full user text '.repeat(300);
  const input = JSON.parse(agentInput({ text: longText, messageContent: card, groupContext: { messages: [
    { messageId: 'g1', timestamp: '26/01/01-08:00', text: 'batch body', revision: 1 },
  ] } }));
  assert.equal(input.type, 'record'); assert.equal(input.timestamp, undefined); assert.equal(input.speaker, undefined);
  assert(input.components.some(item => item.type === 'text' && item.text === longText));
  assert(input.components.some(item => item.type === 'record' && item.messageId === card.messageId));
  const batch = input.components.find(item => item.source === 'group_discussion_batch');
  assert.equal(batch.timestamp, undefined); assert.equal(batch.components[0].timestamp, '26/01/01-08:00');
  assert.equal(body(batch.components[0]), 'batch body');

  // Initial input and explicit detail use the same shallow representation.
  const foreground = new ForegroundRequests({ store, messageImages: images, messageRecords: records, recordMessageElements() {} });
  const prepared = await foreground.prepare({ scope, private: true, admin: false }, incoming('forwarded'));
  assert.deepEqual(prepared.messageContent, contentCodecs.value('message.record', await records.find(scope, 'forwarded')).to('message.content').single());
  assert(!JSON.stringify(prepared).includes('DEEP_BODY'));

  // Group collection uses that representation too, without reading inner bodies.
  const groupScope = 'group:fixture';
  const group = { allowed: true, listen: true };
  const groupPath = join(root, 'groups', `${scopeId(groupScope)}.json`);
  await store.write(groupPath, group);
  const groupMessage = { ...incoming('group-forward', { msgType: 102, msgElements: [{ content: 'GROUP_INNER_BODY' }] }),
    kind: 'group', groupOpenid: 'fixture' };
  groupMessage.structure = await records.capture(groupScope, groupMessage, null, true);
  await groups.append(groupMessage);
  const snapshot = await groups.snapshot(groupScope, { batch: true });
  assert(!JSON.stringify(snapshot).includes('GROUP_INNER_BODY'));
  assert.equal(forward(snapshot.messages[0].message).count, 1);
  const access = row => assertMessageAccess(groupScope, store, row);
  assert.equal(body((await records.detail(groupScope, 'group-forward', { assertAccess: access })).items[0]), 'GROUP_INNER_BODY');
  await store.write(groupPath, { allowed: true, listen: false });
  await assert.rejects(records.detail(groupScope, 'group-forward', { assertAccess: access }), /GROUP_MESSAGES_DISABLED/);
  await store.write(groupPath, group);
  let revoked = false;
  await assert.rejects(records.detail(groupScope, 'group-forward', { assertAccess: async row => {
    await access(row);
    if (row?.embedded && !revoked) { revoked = true; await store.write(groupPath, { allowed: false }); }
  } }), /GROUP_MESSAGES_DISABLED/);

  const tools = new Map();
  closeTools = registerMessageTools(toolRegistrar({ registerTool(name, options, action) {
    tools.set(name, { schema: z.object(options.inputSchema), action });
  } }, { get_message_detail: {}, get_audio_detail: {} }), { scope, store, records, messageImages: images });
  assert(toolApprovals().enabled_tools.includes('get_message_detail'));
  assert(!toolApprovals().enabled_tools.includes('get_message_record'));
  const audioTool = tools.get('get_audio_detail');
  const audioResponse = await audioTool.action({ id: media(noUrl)[0].id, method: 'qq' });
  assert.equal(audioResponse.isError, undefined); assert.equal(JSON.parse(audioResponse.content[0].text).text, 'new ASR');
  const detail = tools.get('get_message_detail');
  assert(!detail.schema.safeParse({ id: 'forwarded', limit: 21 }).success);
  const result = JSON.parse((await detail.action(detail.schema.parse({ id: 'forwarded', limit: 1 }))).content[0].text);
  assert.equal(result.nextOffset, 1);

  // Deletion during a read is caught before any captured bodies are returned.
  let cleared = false;
  await assert.rejects(records.detail(scope, 'forwarded', { assertAccess: async row => {
    if (row?.embedded && !cleared) { cleared = true; await records.clear(scope); }
  } }), /MESSAGE_NOT_RETAINED/);
  console.log('Content codecs: offline integration checks passed.');
} finally {
  await closeTools?.(); await records.close(); await images.close(); await groups.close();
  await rm(root, { recursive: true, force: true });
}
