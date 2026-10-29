import { createHash } from 'node:crypto';
import { contentCodecs } from './content-codecs.mjs';
import { redactCredentials } from './policy.mjs';
import { messageImageAttachments } from './message-images.mjs';
import { assertRecord } from './record.mjs';
import { messageCard, messageFormat, normalizeQQText, messageAttachments } from './message-elements.mjs';
import { redactQQMediaUrls } from './qq-images.mjs';

const clean = (value, limit = 160) => redactQQMediaUrls(redactCredentials(String(value ?? ''))).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, limit);
function attachmentKind(item) {
  const type = String(item.content_type ?? '').toLowerCase();
  if (type === 'file') return 'file';
  if (type === 'voice' || type === 'audio' || type.startsWith('audio/')) return 'audio';
  if (type === 'video' || type.startsWith('video/')) return 'video';
  if (type === 'image' || messageImageAttachments({ attachments: [item] }).length) return 'image';
  return 'file';
}

// Attach current reading hints to media components.
function attachmentReading(item) {
  if (item.type === 'audio') return { ...item, readable: true, detailTool: 'get_audio_detail', methods: ['qq', 'local'],
    limitation: '按附件id调用get_audio_detail，method选择qq读取平台已投递的转写或local使用本地识别；转写未核实，不理解音乐，本地依赖可能未配置' };
  if (item.type === 'video') return { ...item, readable: true, detailTool: 'read_media',
    limitation: '按附件id作为attachment_id调用read_media读取视频资料和抽样画面；尚未观看，不读取音轨' };
  if (item.type === 'image') return { ...item, readable: !!item.imageId, detailTool: 'get_image_detail', animationTool: 'read_media', limitation: item.imageId
    ? '按 imageId 调用 get_image_detail 读取实际图片' : 'Image reference unavailable; do not infer pixels.' };
  return item;
}

// Pure QQ decoder. Capture/storage supplies resolved references and image IDs;
// private download URLs are returned separately and never encoded for consumers.
contentCodecs.register('qq.message', 'message.record', (message, {
  scope, imageRefs, isBotAdmin, element, elements, quote,
}) => {
  const attachments = []; const privateAttachments = [];
  const attachmentItems = messageAttachments(message);
  const imageItems = messageImageAttachments({ attachments: attachmentItems });
  for (const [index, item] of attachmentItems.entries()) {
    if (!item || typeof item !== 'object') continue;
    const kind = attachmentKind(item);
    const id = createHash('sha256').update(`${scope}\0${message.messageId}\0attachment\0${index}`).digest('hex').slice(0, 32);
    const imageIndex = imageItems.indexOf(item);
    attachments.push(attachmentReading({ id, type: kind, filename: clean(item.filename), contentType: clean(item.content_type, 100),
      ...(item.metadataSource === 'qq_textual_attachment' ? { source: 'qq_textual_attachment', untrusted: true } : {}),
      ...(kind === 'image' ? { imageId: imageRefs[imageIndex]?.id ?? null } : {}),
      ...(Number.isFinite(item.size) && item.size >= 0 ? { size: item.size } : {}),
      ...(item.asr_refer_text ? { transcript: { text: clean(item.asr_refer_text, Infinity), source: 'qq_platform_asr', untrusted: true } } : {}),
      readable: kind === 'image' && !!imageRefs[imageIndex]?.id,
      limitation: kind === 'image' ? imageRefs[imageIndex]?.id ? '按 imageId 调用 get_image_detail 读取实际图片' : 'Image reference unavailable; do not infer pixels.'
        : kind === 'audio' ? '平台转写未核实，不代表已经听过音频'
        : kind === 'video' ? '仅收到视频附件，尚未解码观看' : '仅收到文件元数据，尚未读取正文',
    }));
    if (typeof item.url === 'string' && item.url.length <= 8192) privateAttachments.push({ id, kind, url: item.url });
  }
  let components = [];
  const text = redactCredentials(normalizeQQText(message.content));
  if (text) components.push({ type: 'text', text });
  components.push(...attachments);
  const card = element?.card ?? messageCard(message);
  if (card) {
    const { type: cardType, ...fields } = card;
    components.push({ ...fields, type: 'card', cardType });
  }
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).map(item => ({
    openid: clean(item.member_openid || item.user_openid || item.id, 200) || null,
    name: clean(item.nickname || item.username, 80) || null, everyone: item.scope === 'all', isBot: item.is_you === true,
  }));
  if (mentions.length) components.push({ type: 'mentions', items: mentions });
  if (elements) {
    const { children = [], ...fields } = elements;
    if (!children.length) components.push({ ...fields, type: 'record_ref', messageId: null });
    else components.push({ ...fields, type: 'record', components: children.map(child => ({
      ...child, type: 'record_ref', detailTool: 'get_message_detail',
    })) });
  }
  if (quote) components.push({ ...quote, type: 'record_ref', relation: 'quote',
    ...(quote.messageId ? { detailTool: 'get_message_detail' } : { status: 'BODY_NOT_DELIVERED' }) });
  if (Array.isArray(message.onebotParts)) {
    // Ordered OneBot segments reuse indexed attachments and the same delivered
    // child graph; refs are leaves and never trigger reads here.
    components = message.onebotParts.flatMap(part => {
      if (part.type === 'text') return [{ type: 'text', text: redactQQMediaUrls(redactCredentials(part.text)) }];
      if (part.type === 'attachment') return attachments[part.index] ? [attachments[part.index]] : [];
      if (part.type === 'card') {
        const { type: cardType, ...fields } = part.card;
        return [{ ...fields, type: 'card', cardType }];
      }
      if (part.type === 'children') return [{ type: 'record', relation: part.relation,
        components: (elements?.children ?? []).slice(part.start, part.start + part.count).map(child => ({
          ...child, type: 'record_ref', detailTool: 'get_message_detail',
        })) }];
      if (part.type === 'reference') return [{ type: 'record_ref', messageId: part.messageId,
        relation: part.relation, status: part.status, ...(part.messageId ? { detailTool: 'get_message_detail' } : {}) }];
      return [];
    });
    if (mentions.length) components.push({ type: 'mentions', items: mentions });
  }
  const record = { type: 'record', components, messageId: clean(message.messageId, 200), referenceIndex: element ? null : clean(message.msgIdx, 200) || null,
    source: element ? 'qq_embedded_message' : message.forwardDetail ? 'qq_forward_detail' : scope.startsWith('group:') ? 'qq_group_message' : 'qq_private_message', quoted: false, untrusted: true,
    ...(element ? { embedded: { parentMessageId: element.parentMessageId, depth: element.depth, path: element.path,
      reportedMessageId: element.reportedMessageId, reportedMessageIndex: element.reportedMessageIndex,
      identityVerified: false } } : {}),
    format: messageFormat(message),
    speaker: { openid: clean(message.senderId, 200) || null, name: clean(message.senderName, 80) || null,
      ...(!scope.startsWith('group:') ? { isBotAdmin: !element && typeof isBotAdmin === 'boolean' ? isBotAdmin : null } : {}) },
    timestamp: clean(message.timestamp, 80) || null,
    attachmentsTruncated: false };

  if (message.forwardDetail) { delete record.speaker; delete record.timestamp; }
  const privateForwards = (message.onebotParts ?? []).filter(part => part.type === 'reference' && part.resourceId)
    .map(part => ({ id: part.messageId, resourceId: part.resourceId }));
  return { record, privateAttachments, privateForwards };
});

// Initial input, group batches and detail pages share the same recursive shape.
// Folding is a model-facing projection only; storage and explicit content pages
// keep the complete record. Rendering performs no I/O or reference expansion.
contentCodecs.register('message.record', 'message.content', (value, { expandCards = false } = {}) => {
  const render = record => {
    if (!record) return null;
    if (record.type === 'record_ref') return record;
    const normalized = assertRecord(record);
    const components = normalized.components.filter(component => expandCards || !normalized.components.some(item => item.type === 'card')
      || component.type !== 'text' || !component.text.startsWith('[卡片消息]'));
    const result = { ...normalized, components: components.map(component => component.type === 'card' && !expandCards
      ? { type: 'card', text: `[${component.name || component.cardType || 'card'}:${(component.title || component.prompt || component.description || '').slice(0, 200)}]`,
          folded: true, messageId: normalized.messageId, detailTool: 'get_message_detail', untrusted: true }
      : component.type === 'record'
      ? render(component) : component.type === 'text' && normalized.messageId && component.text.length > 1200
        ? { type: 'text', text: `[Folded ${component.text.length} characters: ${normalized.messageId}]`,
          folded: true, characters: component.text.length, messageId: normalized.messageId, detailTool: 'get_message_detail' }
        : attachmentReading(component)) };
    if (JSON.stringify(result).length > 6000 && normalized.messageId) return { type: 'record_ref',
      messageId: normalized.messageId, source: normalized.source, speaker: normalized.speaker, timestamp: normalized.timestamp,
      status: 'DETAIL_REQUIRED', componentCount: normalized.components.length, detailTool: 'get_message_detail' };
    return result;
  };
  return render(value);
});
