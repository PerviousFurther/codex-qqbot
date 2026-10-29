import { recordComponents, recordReferences } from '../lib/record.mjs';
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
import { ConversationRequests } from '../lib/conversation-requests.mjs';
import { Store } from '../lib/store.mjs';
import { registerMessageTools } from '../lib/tools/messages.mjs';
import { toolApprovals } from '../lib/tool-policy.mjs';
import { assertMessageAccess } from '../lib/message-access.mjs';
import { scopeId, redactCredentials } from '../lib/policy.mjs';
import { messageCard, normalizeQQText, normalizeQQMessage } from '../lib/message-elements.mjs';
import { z } from 'zod';
import { dispatchEvent } from '@tencent-connect/qqbot-nodejs/protocol';
import { QQChannel } from '../lib/qq-channel.mjs';

const media = record => record.components.filter(item => ['image', 'audio', 'video', 'file'].includes(item.type));
const forward = record => record.components.find(item => ['forwarded', 'parallel', 'embedded'].includes(item.relation));
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

  // Start at the actual pinned SDK dispatcher and inbound handler, rather
  // than constructing the project's normalized message shape by hand. No SDK
  // connection/start or transport calls occur; only synthetic events are supplied.
  {
    const diagnostics = [], received = [], errors = [];
    const controller = { store, messageImages: images, messageRecords: records, recordMessageElements() {},
      debug: { record: (scope, stage, data) => diagnostics.push({ scope, stage, data }) } };
    const requests = new ConversationRequests(controller);
    controller.groupRuntime = { observe: async message => {
      if (message.kind !== 'group') return;
      await requests.capture(`group:${message.groupOpenid}`, message, null, true);
      await groups.append(message); received.push(message);
    } };
    const channel = new QQChannel({ appId: 'fixture-bot', appSecret: 'fixture-secret', menuEnabled: false, controller });
    channel.handleMessage = async message => { await requests.capture(`c2c:${message.senderId}`, message, false); received.push(message); };
    channel.bot.on('error', error => errors.push(error));
    const link = 'https://www.bilibili.com/video/BV1234567890';
    const fields = { fields: { title: 'Fixture', url: link } };
    const mini = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: 'Fixture', qqdocurl: link, preview: 'https://example.com/cover.png' } } };
    for (const kind of ['c2c', 'group']) for (const [shape, ark, expected] of [
      ['fields', fields, link], ['json-fields', JSON.stringify(fields), link],
      ['mini', mini, link], ['json-mini', JSON.stringify(mini), link],
      ['preview-only', { fields: { preview: 'https://example.com/cover.png' } }, null],
      ['no-ark', undefined, null],
      ['source-logo', { fields: { preview: 'https://example.com/preview.png', source: 'Fixture source', source_logo: 'https://example.com/logo.png', title: 'Fixture' } }, null],
      ['nested-logo', { fields: { source_logo: { url: 'https://example.com/logo.png' } } }, null],
    ]) {
      const id = `${kind}-${shape}`;
      const raw = { id, content: '', timestamp: new Date().toISOString(), message_type: 3,
        author: kind === 'group' ? { member_openid: 'sdk-fixture' } : { user_openid: 'sdk-fixture' },
        group_openid: kind === 'group' ? 'sdk-fixture' : undefined,
        ...(ark === undefined ? {} : { ark_data: ark }), extra_delivered_field: { preserved: true } };
      const dispatched = dispatchEvent(kind === 'group' ? 'GROUP_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', raw, 'fixture-bot');
      assert.equal(dispatched.action, 'message'); assert.equal(dispatched.msg.raw, raw);
      await channel.bot.handleInboundMessage(dispatched.msg);
      assert.equal(errors.length, 0); assert.equal(received.at(-1).raw, raw);
      assert.deepEqual(received.at(-1).raw.extra_delivered_field, { preserved: true });
      const detail = await records.detail(`${kind}:sdk-fixture`, id);
      const card = detail.message.components.find(item => item.type === 'card');
      assert.equal(card?.url ?? null, expected, id);
      const event = diagnostics.find(e => e.stage === 'card_received' && e.data.requestId === received.at(-1).requestId);
      if (shape === 'source-logo' || shape === 'nested-logo') assert.equal(event.data.cardOtherUrls, 0);
      assert.equal(event.data.reason, expected ? 'CARD_LINK_AVAILABLE' : shape === 'no-ark' ? 'CARD_DATA_ABSENT' : 'CARD_DESTINATION_ABSENT');
    }
    assert.equal(received.length, 16);
  }

  const card = await records.capture(scope, incoming('card', { msgType: 3,
    raw: { ark_data: { ark_name: 'video', fields: { title: '标题', desc: '平台说明', url: 'https://www.bilibili.com/video/BV1234567890' } } } }), false);
  const cardComponent = card.components.find(item => item.type === 'card');
  assert.equal(cardComponent.title, '标题'); assert.equal(cardComponent.description, '平台说明');
  assert.equal(cardComponent.url, 'https://www.bilibili.com/video/BV1234567890');
  assert.equal(card.type, 'record'); assert.equal(card.card, undefined);
  assert.equal(contentCodecs.value('message.record', card).to('message.content').single().components.find(item => item.type === 'card').text, '[video:标题]');
  const tokenCard = await records.capture(scope, incoming('token-card', { raw: { ark_data: {
    fields: { title: '标题', url: 'https://example.com/?token=fixture' } } } }), false);
  assert(!JSON.stringify(tokenCard).includes('token=fixture'));

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
  // Mixed share/sticker/attachment regression matrix: capture -> retained detail ->
  // foreground/batch projection -> actual model input. No acquisition is performed.
  for (const [format, ark] of Object.entries({
    fields: { fields: { title: 'Fixture', url: 'https://example.com/shared' } },
    mini: { meta: { detail_1: { title: 'Fixture', qqdocurl: 'https://example.com/shared' } } },
  })) for (const kind of ['c2c', 'group']) for (const serialized of [false, true]) {
    const target = `${kind}:card-matrix`;
    const id = `${format}-${kind}-${serialized}`;
    const delivered = incoming(id, { kind, groupOpenid: kind === 'group' ? 'card-matrix' : undefined,
      content: '[<face,id=14/>]', msgType: 3,
      raw: { ark_data: serialized ? JSON.stringify(ark) : ark },
      attachments: [
        { content_type: 'image/gif', filename: 'sticker.gif', url: 'https://example.com/sticker.gif?token=private' },
        { content_type: 'file', filename: 'fixture.txt', url: 'https://example.com/file?token=private' },
      ] });
    const captured = await records.capture(target, delivered, false, kind === 'group');
    const retained = (await records.detail(target, id)).message;
    const projection = contentCodecs.value('message.record', retained).to('message.content').single();
    const model = JSON.parse(agentInput(kind === 'group'
      ? { groupContext: { messages: [{ message: projection }] } } : { messageContent: projection }));
    for (const value of [captured, retained, projection, model]) {
      const parts = [...recordComponents(value)];
      const share = parts.find(part => part.type === 'card');
      if (share.folded) {
        assert.equal(share.text, '[card:Fixture]', id);
        assert.equal(share.fields, undefined); assert.equal(share.detailTool, 'get_message_detail');
      } else {
        assert.equal(share.url, 'https://example.com/shared', id);
        assert.equal(share.title, 'Fixture', id);
      }
      const image = parts.find(part => part.type === 'image');
      assert(image.imageId, id); assert.equal(image.contentType, 'image/gif');
      assert.equal(image.animationTool, 'read_media');
      assert(parts.some(part => part.type === 'file' && part.filename === 'fixture.txt'));
      assert(!JSON.stringify(value).includes('token=private'));
    }
  }
  const { sharedRecord } = await import('../lib/context-access.mjs');
  const deliveredFields = { title: 'Unknown fields', opaque: { nested: [1, true, 'original'] }, openid: 'PRIVATE_ID',
    jump_url: 'https://example.com/share', access_token: 'PRIVATE_TOKEN',
    odd_url: 'https://user:PRIVATE_PASSWORD@example.com/path?token=PRIVATE_QUERY' };
  const fieldRecord = await records.capture(scope, incoming('raw-fields-card', { msgType: 3,
    content: '[卡片消息] 小程序\npreview: original cover',
    raw: { ark_data: { ark_type: 'miniapp', ark_name: '小程序', fields: deliveredFields } } }), false);
  const folded = contentCodecs.value('message.record', fieldRecord).to('message.content').single();
  assert.equal(folded.components.length, 1);
  assert.equal(folded.components[0].text, '[小程序:Unknown fields]');
  assert(!JSON.stringify(folded).includes('opaque'));
  const expanded = await records.detail(scope, 'raw-fields-card');
  const fullCard = expanded.message.components.find(part => part.type === 'card');
  assert.deepEqual(fullCard.fields.opaque, deliveredFields.opaque);
  assert.equal(fullCard.fields.access_token, '[redacted]');
  assert(!/PRIVATE_TOKEN|PRIVATE_PASSWORD|PRIVATE_QUERY/.test(JSON.stringify(expanded)));
  assert(JSON.parse(expanded.contentPage.text).components.some(part => part.type === 'card' && part.fields.opaque));
  const sharedExpanded = await records.detail(scope, 'raw-fields-card', { projectRecord: sharedRecord });
  assert(!sharedExpanded.contentPage.text.includes('PRIVATE_ID'));
  assert(JSON.parse(sharedExpanded.contentPage.text).components.find(part => part.type === 'card').fields.opaque);
  const legacyCard = { type: 'record', messageId: 'old-card', components: [{ type: 'card', cardType: 'miniapp', title: 'Legacy' }] };
  assert.equal(contentCodecs.value('message.record', legacyCard).to('message.content').single().components[0].text, '[miniapp:Legacy]');
  assert.equal(contentCodecs.value('message.record', legacyCard).to('message.content', { expandCards: true }).single().components[0].fields, undefined);

  const embeddedCard = await records.capture(scope, incoming('nested-fields-card', { msgType: 102,
    msgElements: [{ message_type: 3, ark_data: { fields: deliveredFields } }] }), false);
  assert(!JSON.stringify(embeddedCard).includes('https://example.com/share'));
  const embeddedDetail = await records.detail(scope, 'nested-fields-card');
  assert.deepEqual(embeddedDetail.items[0].components.find(part => part.type === 'card').fields.opaque, deliveredFields.opaque);
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
  const references = contentCodecs.value('message.record', forwarded).to('message.content').single();
  const childReference = forward(references).components[0];
  assert.equal(childReference.type, 'record_ref');
  assert.equal(childReference.detailTool, 'get_message_detail');
  assert(!('components' in childReference)); assert(!('text' in childReference));
  assert.deepEqual([...recordComponents(childReference)], []);
  assert.deepEqual(recordReferences(references), forward(references).components.map(c => c.messageId));
  assert.deepEqual(recordReferences({ type: 'record', components: [{ type: 'record', messageId: 'direct-child',
    components: [{ type: 'record_ref', messageId: 'grandchild' }] }] }), ['direct-child']);
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
  assert.equal(forward(many).status, 'DELIVERED');
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
  assert.equal(quote.components.find(c => c.relation === 'quote').type, 'record_ref');
  assert(!('components' in quote.components.find(c => c.relation === 'quote')));
  assert(!JSON.stringify(contentCodecs.value('message.record', quote).to('message.content').single()).includes('QUOTED_BODY'));
  assert.equal(body((await records.detail(scope, 'quote')).items[0]), 'QUOTED_BODY');
  const storedGraphDb = await records.database(scope);
  storedGraphDb.prepare('INSERT INTO records(id,received,historical,body) VALUES(?,?,0,?)').run('stored-graph', Date.now(),
    JSON.stringify({ type: 'record', messageId: 'stored-graph', components: [{ type: 'record', relation: 'forwarded',
      components: [{ type: 'record', messageId: 'original', status: 'NOT_EXPANDED', components: [] }] }] }));
  assert.equal(body((await records.detail(scope, 'stored-graph')).items[0]), 'QUOTED_BODY');

  // Quote references use the same decoder at the root and inside a forward.
  // Preserve actual reference fields; never mistake a node's own index for one.
  for (const [name, raw] of Object.entries({
    reference: { message_reference: { message_id: 'original' } },
    scene: { message_scene: { ext: ['msg_idx=own-index', 'ref_msg_idx=quote-index'] } },
  })) {
    const top = await records.capture(scope, incoming(`quote-${name}`, { msgType: 103, content: 'reply', raw }), false);
    assert.equal(top.components.find(c => c.relation === 'quote').messageId, 'original');
    const outer = await records.capture(scope, incoming(`nested-quote-${name}`, { msgType: 102,
      msgElements: [{ ...raw, message_type: 103, content: 'reply' }] }), false);
    const inner = (await records.detail(scope, outer.messageId)).items[0];
    assert.equal(inner.components.find(c => c.relation === 'quote').messageId, 'original');
    assert.equal(body((await records.detail(scope, inner.messageId)).items[0]), 'QUOTED_BODY');
  }
  const snapshotQuote = await records.capture(scope, incoming('snapshot-quote', { msgType: 103, refMsgIdx: 'quote-index',
    msgElements: [{ message_type: 103, msg_idx: 'quote-index', content: 'DELIVERED_SNAPSHOT' }] }), false);
  assert.deepEqual(snapshotQuote.components.filter(c => c.type === 'record').map(c => c.relation), ['quote']);
  const snapshotPage = await records.detail(scope, snapshotQuote.messageId);
  assert.equal(snapshotPage.items.length, 1); assert.equal(body(snapshotPage.items[0]), 'DELIVERED_SNAPSHOT');
  assert(!snapshotPage.items[0].components.some(c => c.relation === 'quote')); // No invented next layer.
  const nestedSnapshot = await records.capture(scope, incoming('nested-snapshot', { msgType: 102,
    msgElements: [{ message_type: 103, content: 'nested reply', msg_elements: [
      { msg_idx: 'quote-index', content: 'NESTED_QUOTED_BODY' },
    ] }] }), false);
  const nestedReply = (await records.detail(scope, nestedSnapshot.messageId)).items[0];
  assert.deepEqual(nestedReply.components.filter(c => c.type === 'record').map(c => c.relation), ['quote']);
  assert.equal(body((await records.detail(scope, nestedReply.messageId)).items[0]), 'NESTED_QUOTED_BODY');
  const parallel = await records.capture(scope, incoming('parallel', { msgType: 101, msgElements: [{ content: 'parallel child' }] }), false);
  assert.equal(forward(parallel).relation, 'parallel');

  // One publication transaction owns every node, with one expiry pass.
  const graphDb = await records.database(scope); const exec = graphDb.exec;
  let transactions = 0;
  graphDb.exec = function(sql) { if (sql === 'BEGIN IMMEDIATE') transactions++; return exec.call(this, sql); };
  try {
    await records.capture(scope, incoming('atomic-graph', { msgType: 102,
      msgElements: Array.from({ length: 80 }, (_, i) => ({ content: `node ${i}` })) }), false);
    assert.equal(transactions, 1);
  } finally { graphDb.exec = exec; }

  // QQ acquisition URLs in textual summaries are not media references and must
  // not leak through initial input, nested detail, content pages or group recall.
  const privateUrl = 'https://multimedia.nt.qq.com.cn/download?fileid=fixture&rkey=PRIVATE_FIXTURE';
  const summaryPreview = `[群聊的聊天记录]\n[附件1] URL:${privateUrl}\nhttps://example.com/public`;
  const textual = await records.capture(scope, incoming('textual-preview', { content: summaryPreview, msgType: 102,
    msgElements: [{ content: summaryPreview, attachments: [{ content_type: 'image/png', url: privateUrl }] }] }), false);
  const textualInput = agentInput({ messageContent: contentCodecs.value('message.record', textual).to('message.content').single() });
  const textualPage = await records.detail(scope, textual.messageId);
  assert(!JSON.stringify([textualInput, textualPage]).includes('PRIVATE_FIXTURE'));
  for (const url of [privateUrl, '//gchat.qpic.cn/fixture?key=PRIVATE_FIXTURE', 'https://c2cpicdw.qpic.cn/fixture']) {
    assert.equal(messageCard({ raw: { ark_data: { fields: { url } } } }).linkStatus, 'NO_USABLE_LINK');
  }
  assert(JSON.stringify(textualPage).includes('https://example.com/public'));
  assert.equal((await records.attachment(scope, media(textualPage.items[0])[0].id)).url, privateUrl);
  // Complete delivered descriptors feed the canonical attachment path before
  // redaction; bare URLs above do not infer images. Check actual model inputs.
  for (const kind of ['c2c', 'group']) {
    const descriptorMessage = { ...incoming(`descriptor-${kind}`, { kind, msgType: 102,
      content: `[群聊的聊天记录]\n[附件1] 类型:图片 文件名:fixture.png 尺寸:12x10 大小:1KB URL:${privateUrl}` }),
      groupOpenid: kind === 'group' ? 'descriptor-fixture' : undefined };
    normalizeQQMessage(descriptorMessage);
    const descriptorScope = `${kind}:descriptor-fixture`;
    descriptorMessage.structure = await records.capture(descriptorScope, descriptorMessage, false, kind === 'group');
    const image = media(descriptorMessage.structure)[0]; assert(image.imageId);
    const projection = contentCodecs.value('message.record', descriptorMessage.structure).to('message.content').single();
    if (kind === 'group') await groups.append(descriptorMessage);
    const encoded = agentInput(kind === 'group' ? { groupContext: await groups.snapshot(descriptorScope, { batch: true }) }
      : { messageContent: projection });
    assert(encoded.includes(image.imageId)); assert(!encoded.includes('PRIVATE_FIXTURE'));
    assert.equal((await records.attachment(descriptorScope, image.id)).url, privateUrl);
  }
  // Old supported records remain readable without rewriting their stored bytes.
  const oldBody = { type: 'record', messageId: 'old-private-preview', source: 'qq_private_message',
    components: [{ type: 'text', text: summaryPreview }] };
  graphDb.prepare('INSERT INTO records(id,received,historical,body) VALUES(?,?,0,?)')
    .run(oldBody.messageId, Date.now(), JSON.stringify(oldBody));
  assert(!JSON.stringify(await records.detail(scope, oldBody.messageId)).includes('PRIVATE_FIXTURE'));
  assert(graphDb.prepare('SELECT body FROM records WHERE id=?').get(oldBody.messageId).body.includes('PRIVATE_FIXTURE'));

  const missing = await records.capture(scope, incoming('missing', { msgType: 102 }), false);
  assert.equal(forward(contentCodecs.value('message.record', missing).to('message.content').single()).status, 'BODY_NOT_DELIVERED');
  assert.equal(forward(missing).type, 'record_ref'); assert(!('components' in forward(missing)));
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
  assert(!input.components.some(item => item.type === 'text' && item.text === longText));
  assert(input.components.some(item => item.type === 'record' && item.messageId === card.messageId));
  const batch = input.components.find(item => item.source === 'group_discussion_batch');
  assert.equal(batch.timestamp, undefined); assert.equal(batch.components[0].timestamp, '26/01/01-08:00');
  assert.equal(body(batch.components[0]), 'batch body');

  // Initial input and explicit detail use the same shallow representation.
  const foreground = new ConversationRequests({ store, messageImages: images, messageRecords: records, recordMessageElements() {} });
  const prepared = await foreground.prepare({ scope, private: true, admin: false }, incoming('forwarded'));
  assert.deepEqual(prepared.messageContent, contentCodecs.value('message.record', await records.find(scope, 'forwarded')).to('message.content').single());
  assert(!JSON.stringify(prepared).includes('DEEP_BODY'));

  // Both input policies capture through the same owner without re-indexing a
  // message during active-turn intake. Equal platform IDs stay scope-local.
  let capturedGraphs = 0; let captureEvents = 0;
  const requests = new ConversationRequests({ store, messageImages: images,
    messageRecords: { capture: async (...args) => { capturedGraphs++; return records.capture(...args); },
      find: (...args) => records.find(...args) }, recordMessageElements() { captureEvents++; } });
  for (const kind of ['c2c', 'group']) {
    const captureScope = `${kind}:capture-fixture`;
    const message = incoming('same-id', { kind, groupOpenid: kind === 'group' ? 'capture-fixture' : undefined,
      content: `${kind} body`, msgType: 102, msgElements: [{ content: `${kind} nested body` }] });
    const captured = await requests.capture(captureScope, message, kind === 'c2c' ? true : null, kind === 'group');
    assert.equal(await requests.capture(captureScope, message, null, kind === 'group'), captured);
    assert.equal(body(await records.find(captureScope, 'same-id')), `${kind} body`);
    assert.equal(captured.historical, kind === 'group');
    assert.equal((await records.detail(captureScope, 'same-id')).items[0].components[0].text, `${kind} nested body`);
    if (kind === 'group') assert.equal(captured.speaker.isBotAdmin, undefined);
  }
  assert.equal(capturedGraphs, 2); assert.equal(captureEvents, 2);

  // Group collection uses that representation too, without reading inner bodies.
  const groupScope = 'group:fixture';
  const group = { allowed: true, listen: true };
  const groupPath = join(root, 'groups', `${scopeId(groupScope)}.json`);
  await store.write(groupPath, group);
  const groupMessage = { ...incoming('group-forward', { msgType: 102, msgElements: [{ content: 'GROUP_INNER_BODY' }] }),
    kind: 'group', groupOpenid: 'fixture' };
  groupMessage.structure = await records.capture(groupScope, groupMessage, null, true);
  await groups.append(groupMessage);
  await assert.rejects(groups.append({ ...groupMessage, structure: undefined }), /MESSAGE_RECORD_FORMAT_UNSUPPORTED/);
  await assert.rejects(groups.append({ ...groupMessage, messageId: 'mismatched' }), /MESSAGE_RECORD_MISMATCH/);
  const snapshot = await groups.snapshot(groupScope, { batch: true });
  assert(!JSON.stringify(snapshot).includes('GROUP_INNER_BODY'));
  assert.equal(forward(snapshot.messages[0].message).count, 1);
  assert(!('text' in snapshot.messages[0]));
  assert(!('images' in snapshot.messages[0]));
  const recalledGroup = await groups.recall(groupScope);
  assert(!('text' in recalledGroup.messages[0]));
  const privatePreviewGroup = { ...incoming('group-private-preview', { content: summaryPreview }), kind: 'group', groupOpenid: 'preview-fixture' };
  privatePreviewGroup.structure = await records.capture('group:preview-fixture', privatePreviewGroup, null, true);
  await groups.append(privatePreviewGroup);
  assert(!JSON.stringify(await groups.recall('group:preview-fixture')).includes('PRIVATE_FIXTURE'));
  assert(!agentInput({ groupContext: await groups.snapshot('group:preview-fixture', { batch: true }) }).includes('PRIVATE_FIXTURE'));
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

  // Complete originals are independent of bounded model input and detail pages.
  const rawSpacing = '  first line\r\nlast line SESSDATA=private-fixture-secret  ';
  const redacted = await records.capture(scope, incoming('redacted', { content: rawSpacing }), false);
  assert.equal(body(redacted), redactCredentials(rawSpacing));
  assert(!agentInput({ text: rawSpacing, messageContent: contentCodecs.value('message.record', redacted)
    .to('message.content').single() }).includes('private-fixture-secret'));
  assert.equal(body(redacted).startsWith('  first line\r\n'), true);
  const fullText = '完整正文😀'.repeat(5000) + 'TAIL_SEARCH_NEEDLE';
  const complete = await records.capture(scope, incoming('complete', { content: fullText }), false);
  assert.equal(body(complete), fullText);
  const preview = contentCodecs.value('message.record', complete).to('message.content').single();
  assert.equal(preview.components[0].folded, true);
  assert(!JSON.stringify(preview).includes('TAIL_SEARCH_NEEDLE'));
  assert.equal(JSON.parse(agentInput({ text: fullText, messageContent: preview })).components
    .filter(item => item.type === 'text' && item.text === fullText).length, 0);
  let serialized = '', contentOffset = 0;
  do {
    const result = await records.detail(scope, 'complete', { content_offset: contentOffset, content_limit: 997 });
    assert(JSON.stringify(result).length <= 24000);
    serialized += result.contentPage.text;
    assert(result.contentPage.nextOffset === null || result.contentPage.nextOffset > contentOffset);
    contentOffset = result.contentPage.nextOffset;
  } while (contentOffset !== null);
  assert.equal(body(JSON.parse(serialized)), fullText);
  assert.equal((await records.contextPage(scope, { query: 'TAIL_SEARCH_NEEDLE' })).items[0].id, 'complete');
  const outgoing = await records.captureReply(scope, { text: fullText }, { id: 'complete' });
  assert.equal(body(await records.find(scope, outgoing.messageId)), fullText);
  const fullMetadata = await records.capture(scope, incoming('full-metadata', {
    raw: { ark_data: { fields: { title: fullText, desc: fullText } } },
    mentions: Array.from({ length: 70 }, (_, i) => ({ member_openid: `member-${i}` })),
    attachments: [{ content_type: 'voice', asr_refer_text: fullText }],
  }), false);
  assert.equal(fullMetadata.components.find(item => item.type === 'card').title, fullText);
  assert.equal(fullMetadata.components.find(item => item.type === 'mentions').items.length, 70);
  assert.equal(fullMetadata.components.find(item => item.type === 'audio').transcript.text, fullText);
  const metadataRef = contentCodecs.value('message.record', fullMetadata).to('message.content').single();
  assert.equal(metadataRef.status, 'DETAIL_REQUIRED'); assert.equal(metadataRef.type, 'record_ref');
  assert(!('components' in metadataRef));
  assert.equal(JSON.parse(agentInput({ messageContent: metadataRef })).components[0].type, 'record_ref');
  const groupRefInput = JSON.parse(agentInput({ groupContext: { messages: [{ message: metadataRef }] } }));
  assert.equal(groupRefInput.components[0].components[0].type, 'record_ref');
  const manyAttachments = await records.capture(scope, incoming('attachments', { attachments:
    Array.from({ length: 30 }, (_, i) => ({ content_type: 'image/png', url: `https://gchat.qpic.cn/fixture-${i}` })) }), false);
  assert.equal(media(manyAttachments).length, 30);
  assert(media(manyAttachments).every(item => item.imageId));
  assert.equal((await records.find(scope, 'attachments')).attachmentsTruncated, false);
  const wide = await records.capture(scope, incoming('wide', { msgType: 102, msgElements:
    Array.from({ length: 80 }, (_, i) => ({ content: `${i}:` + fullText })) }), false);
  assert.equal(forward(wide).count, 80); assert.equal(forward(wide).status, 'DELIVERED');
  assert.equal(body(await records.find(scope, forward(wide).components[79].messageId)), '79:' + fullText);
  let deep = { content: 'deep complete' };
  for (let i = 0; i < 80; i++) deep = { msg_elements: [deep] };
  let deepRecord = await records.capture(scope, incoming('deep', { msgElements: [deep] }), false);
  for (let i = 0; i < 81; i++) {
    deepRecord = await records.find(scope, forward(deepRecord).components[0].messageId);
    assert(deepRecord.messageId.length <= 200);
  }
  assert.equal(body(deepRecord), 'deep complete');
  const groupLong = { ...incoming('group-long', { content: fullText }), kind: 'group', groupOpenid: 'long-fixture' };
  groupLong.structure = await records.capture('group:long-fixture', groupLong, null, true);
  await groups.append(groupLong);
  const longSnapshot = await groups.snapshot('group:long-fixture', { batch: true });
  assert.equal(longSnapshot.messages.length, 1); // A large first message cannot starve the batch.
  assert(!JSON.stringify(longSnapshot).includes('TAIL_SEARCH_NEEDLE'));
  const longRecall = await groups.recall('group:long-fixture', { query: 'TAIL_SEARCH_NEEDLE' });
  assert.equal(longRecall.messages[0].messageId, 'group-long');
  const longDb = await groups.database('group:long-fixture');
  assert.equal(longDb.prepare('SELECT text FROM messages WHERE id=?').get('group-long').text, fullText);
  assert.equal(body(JSON.parse(longDb.prepare('SELECT body FROM message_details WHERE message_id=?').get('group-long').body)), fullText);
  assert.equal((await groups.batchStatus('group:long-fixture')).pendingCount, 1); // Reads never consume input.
  assert.equal((await groups.recall('group:long-fixture', { since: new Date(Date.now() + 10000).toISOString(),
    until: new Date(Date.now() + 20000).toISOString() })).messages.length, 0);

  // Record/image retention is time-only, including beyond the old count caps.
  const retentionScope = 'c2c:retention';
  const retentionDb = await records.database(retentionScope);
  retentionDb.exec('BEGIN IMMEDIATE');
  try {
    const insert = retentionDb.prepare('INSERT INTO records(id,received,historical,body) VALUES(?,?,0,?)');
    for (let i = 0; i < 5100; i++) insert.run(`retained-${i}`, Date.now(), JSON.stringify({ type: 'record',
      source: 'qq_private_message', messageId: `retained-${i}`, components: [{ type: 'text', text: 'retained' }] }));
    insert.run('expired', Date.now() - 8 * 86400000, JSON.stringify({ type: 'record', components: [] }));
    records.prune(retentionDb); retentionDb.exec('COMMIT');
  } catch (error) { retentionDb.exec('ROLLBACK'); throw error; }
  assert.equal(retentionDb.prepare('SELECT count(*) AS n FROM records').get().n, 5100);
  assert.equal((await records.contextPage(retentionScope, { offset: 5050, limit: 20 })).items.length, 20);
  const imageDb = await images.database(retentionScope);
  imageDb.exec('BEGIN IMMEDIATE');
  try {
    const insert = imageDb.prepare('INSERT INTO images(id,message_id,sender_id,received,url,historical) VALUES(?,?,?,?,?,0)');
    for (let i = 0; i < 520; i++) insert.run(`image-${i}`, 'fixture', 'fixture', Date.now(), 'https://gchat.qpic.cn/fixture');
    insert.run('expired-image', 'fixture', 'fixture', Date.now() - 8 * 86400000, 'https://gchat.qpic.cn/fixture');
    imageDb.exec('COMMIT');
  } catch (error) { imageDb.exec('ROLLBACK'); throw error; }
  await images.capture(retentionScope, incoming('new-image', { attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/new' }] }));
  assert.equal(imageDb.prepare('SELECT count(*) AS n FROM images').get().n, 521);
  longDb.exec('BEGIN IMMEDIATE');
  try {
    const insert = longDb.prepare('INSERT INTO messages(id,openid,name,timestamp,received,text) VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 5100; i++) insert.run(`kept-${i}`, 'fixture', 'fixture', Date.now(), Date.now(), 'retained');
    insert.run('expired-group', 'fixture', 'fixture', Date.now(), Date.now() - 8 * 86400000, 'expired');
    groups.prune(longDb); longDb.exec('COMMIT');
  } catch (error) { longDb.exec('ROLLBACK'); throw error; }
  assert.equal(longDb.prepare('SELECT count(*) AS n FROM messages').get().n, 5101);

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
