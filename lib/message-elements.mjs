import { scopeId, redactCredentials } from './policy.mjs';

const nestedMessageLimitation = '内层发言者与时间仅为平台内嵌资料，不代表当前群成员或机管身份；需要内部消息时按本记录messageId调用get_message_detail。';

const text = (value, length) => typeof value === 'string' ? redactCredentials(value).slice(0, length) : '';
const limits = { depth: 5, nodes: 40, characters: 24000, attachments: 24 };
export const rawMessageElements = message => Array.isArray(message.msgElements) ? message.msgElements
  : Array.isArray(message.raw?.msg_elements) ? message.raw.msg_elements : [];

// Preserve unknown faces rather than silently dropping a whole sticker-only turn.
export function normalizeQQText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\[<face,id=(\d+)\/?>]/g, (_, id) => `［QQ表情:${id}］`)
    .replace(/<faceType=(\d+),faceId="([^"]*)",ext="([^"]*)">/g, (_, type, id, ext) => {
      let name = '';
      if (ext.length <= 4096) {
        try { name = text(JSON.parse(Buffer.from(ext, 'base64').toString('utf8')).text, 80).replace(/[\x00-\x1f\x7f]/g, ' '); }
        catch { /* A code alone is still useful; it does not identify pixels. */ }
      }
      return `［QQ表情:${text(id, 80)}${name ? ` ${name}` : ''}］`;
    });
}

export function normalizeQQMessage(message, appId) {
  let content = normalizeQQText(message.content);
  if (appId) for (const marker of [`<@${appId}>`, `<@!${appId}>`]) content = content.split(marker).join('');
  message.content = content.trim();
  return message;
}

export function messageFormat(message) {
  const type = message.msgType ?? message.raw?.message_type;
  const kind = ({ 0: 'ordinary', 3: 'card', 101: 'parallel', 102: 'forwarded', 103: 'quote' })[type];
  return { type: Number.isInteger(type) ? type : null, kind: kind ?? (type == null ? 'ordinary' : 'unknown'),
    ...(type != null && !kind ? { limitation: '未识别的QQ消息类型，仅使用实际投递的正文和附件。' } : {}) };
}

export function messageCard(message) {
  const raw = cardObject(message.raw?.ark_data);
  if (!raw) return null;
  const fields = cardObject(raw.fields) ?? {};
  const nodes = []; const seen = new WeakSet();
  const visit = (value, depth) => {
    const node = cardObject(value);
    if (!node || depth > 5 || seen.has(node) || nodes.length >= 64) return;
    seen.add(node); nodes.push(node);
    for (const [key, child] of Object.entries(node).slice(0, 64)) {
      if (!/preview|image|icon|cover|thumb|token|secret|auth|cookie/i.test(key)) visit(child, depth + 1);
    }
  };
  // Traditional fields and mini-app meta.detail_1 use different layouts.
  // Inspect only delivered structured fields; image/preview URLs are not destinations.
  visit(fields, 0); visit(raw, 0);
  const links = [];
  for (const node of nodes) for (const key of ['url', 'jump_url', 'jumpUrl', 'qqdocurl', 'newsUrl', 'contentUrl', 'target_url', 'link']) {
    const url = publicCardLink(node[key]);
    if (url && !links.includes(url) && links.length < 4) links.push(url);
  }
  const first = keys => {
    for (const node of nodes) for (const key of keys) {
      const value = text(node[key], 300);
      if (value) return value;
    }
    return '';
  };
  return { source: 'qq_card_metadata', untrusted: true, name: text(raw.ark_name ?? raw.app, 100), type: text(raw.ark_type, 80),
    prompt: text(raw.prompt, 300), title: first(['title']), description: first(['desc', 'description']),
    ...(links.length ? { url: links[0], links } : { linkStatus: 'NO_USABLE_LINK',
      limitation: 'No usable public HTTP(S) destination was found in the delivered card fields. Do not invent a link or treat a title/preview as page content.' }) };
}

function cardObject(value) {
  if (typeof value === 'string' && value.length <= 24000) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' ? value : null;
}

function publicCardLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /(?:token|secret|auth|key|sign|ticket|cookie)/i.test([...url.searchParams.keys()].join(' '))
      || /(?:token|secret|auth|key|sign|ticket|cookie)/i.test(url.hash)) return null;
    return redactCredentials(url.href);
  } catch { return null; }
}

function missingBody(type, card) {
  return [101, 102].includes(type) || card && /multimsg|forward|聊天记录/i.test(`${card.name} ${card.type} ${card.prompt} ${card.title}`)
    ? { source: 'qq_embedded_messages', children: [], count: 0, status: 'BODY_NOT_DELIVERED',
      limitation: 'QQ只投递了容器或卡片，没有内层消息正文；不能展开或凭摘要猜测内容。' } : null;
}

// Decode only fields actually delivered by QQ. No guessed fetch endpoint or foreign-chat lookup.
export async function captureMessageElements(scope, message, save) {
  const root = rawMessageElements(message);
  const type = message.msgType ?? message.raw?.message_type;
  if (!root.length) return missingBody(type, messageCard(message));
  const seen = new WeakSet();
  const budget = { nodes: 0, characters: 0, attachments: 0 };
  const rootId = scopeId(`${scope}:${message.messageId}`);
  const walk = async (elements, parentId, depth, path) => {
    const children = []; const omitted = new Set();
    if (elements.length > limits.nodes) omitted.add('NODE_LIMIT');
    for (const [index, element] of elements.slice(0, limits.nodes).entries()) {
      if (budget.nodes >= limits.nodes) { omitted.add('NODE_LIMIT'); break; }
      if (!element || typeof element !== 'object' || Array.isArray(element)) { omitted.add('UNSUPPORTED_ELEMENT'); continue; }
      if (seen.has(element)) { omitted.add('REPEATED_ELEMENT'); continue; }
      seen.add(element); budget.nodes++;
      const nodePath = `${path}${index + 1}`;
      const id = `element:${rootId}:${nodePath}`;
      const rawText = normalizeQQText(element.content);
      const content = text(rawText, Math.max(0, Math.min(1200, limits.characters - budget.characters)));
      budget.characters += content.length;
      const rawAttachments = Array.isArray(element.attachments) ? element.attachments : [];
      const attachments = rawAttachments.slice(0, Math.max(0, Math.min(6, limits.attachments - budget.attachments)));
      budget.attachments += attachments.length;
      const nested = Array.isArray(element.msg_elements) ? element.msg_elements : [];
      const nodeType = Number.isInteger(element.message_type) ? element.message_type : null;
      const card = messageCard({ raw: element });
      const forwarded = nested.length ? depth < limits.depth ? await walk(nested, id, depth + 1, `${nodePath}.`)
        : { source: 'qq_embedded_messages', children: [], count: 0, status: 'TRUNCATED', limitations: ['DEPTH_LIMIT'] }
        : missingBody(nodeType, card);
      const author = element.author && typeof element.author === 'object' ? element.author : {};
      const node = await save({ kind: message.kind, groupOpenid: message.groupOpenid, messageId: id,
        senderId: text(author.member_openid ?? author.user_openid ?? author.id, 200),
        senderName: text(author.username ?? author.nickname, 80), content, attachments,
        timestamp: typeof element.timestamp === 'string' ? element.timestamp : null,
        mentions: Array.isArray(element.mentions) ? element.mentions : [], msgType: nodeType,
        raw: { ark_data: element.ark_data },
      }, { parentMessageId: parentId, depth, path: nodePath,
        reportedMessageId: text(element.id, 200) || null, reportedMessageIndex: text(element.msg_idx, 200) || null,
        messageType: nodeType, forwarded, card,
        textTruncated: rawText.length > content.length, attachmentsTruncated: rawAttachments.length > attachments.length });
      if (node.components?.some(item => item.type === 'text' && item.truncated)) omitted.add('TEXT_LIMIT');
      if (node.attachmentsTruncated) omitted.add('ATTACHMENT_LIMIT');
      if (forwarded?.status === 'TRUNCATED') omitted.add('NESTED_LIMIT');
      children.push({ messageId: node.messageId });
    }
    return { source: 'qq_embedded_messages', children, count: children.length,
      status: omitted.size ? 'TRUNCATED' : 'DELIVERED', ...(omitted.size ? { limitations: [...omitted] } : {}) };
  };
  const result = await walk(root, message.messageId, 1, '');
  return { ...result, capturedNodes: budget.nodes, limits, untrusted: true,
    limitation: nestedMessageLimitation };
}
