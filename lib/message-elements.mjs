import { scopeId, redactCredentials } from './policy.mjs';
import { redactQQMediaUrls, isQQMediaUrl } from './qq-images.mjs';

const nestedMessageLimitation = '内层发言者与时间仅为平台内嵌资料，不代表当前群成员或机管身份；需要内部消息时按本记录messageId调用get_message_detail。';

const text = (value, length) => typeof value === 'string' ? redactQQMediaUrls(redactCredentials(value)).slice(0, length) : '';
export const rawMessageElements = message => Array.isArray(message.msgElements) ? message.msgElements
  : Array.isArray(message.raw?.msg_elements) ? message.raw.msg_elements : [];

// Some delivered forward previews contain explicit picture descriptors instead
// of attachment objects. Index only their actual checked URLs and stated fields;
// never reconstruct message nodes, identities, timestamps or missing bodies.
export function messageAttachments(message) {
  const attachments = Array.isArray(message.attachments) ? [...message.attachments] : [];
  const urls = new Set(attachments.map(item => item?.url));
  for (const line of typeof message.content === 'string' ? message.content.split(/\r?\n/) : []) {
    const match = /^\[附件\d+\] 类型:图片 文件名:(.*?) 尺寸:(\d+)x(\d+) 大小:(\S+) URL:(\S+)\s*$/.exec(line);
    if (!match || !isQQMediaUrl(match[5]) || urls.has(match[5])) continue;
    const width = Number(match[2]), height = Number(match[3]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) continue;
    attachments.push({ content_type: 'image', filename: match[1], width, height, url: match[5],
      metadataSource: 'qq_textual_attachment' });
    urls.add(match[5]);
  }
  return attachments;
}

// Identical reference rules for SDK messages and delivered embedded messages.
// A node's own msg_idx identifies that node, never its quoted predecessor.
export function messageReference(message) {
  const raw = message.raw ?? {};
  if ((message.msgType ?? raw.message_type) === 103) {
    const child = rawMessageElements(message).find(item => typeof item?.msg_idx === 'string' && item.msg_idx);
    if (child) return text(child.msg_idx, 200);
  }
  const reference = message.refMsgIdx || raw.message_reference?.message_id;
  if (reference) return text(reference, 200);
  const entry = Array.isArray(raw.message_scene?.ext)
    ? raw.message_scene.ext.find(value => typeof value === 'string' && /^ref_msg_idx\s*=/.test(value)) : null;
  return entry ? text(entry.slice(entry.indexOf('=') + 1).trim(), 200) : '';
}

// Preserve unknown faces rather than silently dropping a whole sticker-only turn.
export function normalizeQQText(value) {
  if (typeof value !== 'string') return '';
  return redactQQMediaUrls(value).replace(/\[<face,id=(\d+)\/?>]/g, (_, id) => `［QQ表情:${id}］`)
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
  // Resolve delivered pointers before text redaction makes the private URL
  // unavailable. Repeated normalization does not add duplicate attachments.
  message.attachments = messageAttachments(message);
  let content = normalizeQQText(message.content);
  if (appId) for (const marker of [`<@${appId}>`, `<@!${appId}>`]) content = content.split(marker).join('');
  message.content = content;
  return message;
}

export function messageFormat(message) {
  const type = message.msgType ?? message.raw?.message_type;
  const kind = ({ 0: 'ordinary', 3: 'card', 101: 'parallel', 102: 'forwarded', 103: 'quote' })[type];
  return { type: Number.isInteger(type) ? type : null, kind: kind ?? (type == null ? 'ordinary' : 'unknown'),
    ...(type != null && !kind ? { limitation: '未识别的QQ消息类型，仅使用实际投递的正文和附件。' } : {}) };
}

// Optional statistics contain fixed counts only and never enter model records.
export function messageCard(message, statistics) {
  const raw = cardObject(message.raw?.ark_data);
  if (!raw) return null;
  const fields = cardObject(raw.fields) ?? {};
  const nodes = []; const seen = new WeakSet();
  const destinations = ['url', 'jump_url', 'jumpUrl', 'qqdocurl', 'newsUrl', 'contentUrl', 'target_url', 'link'];
  const pending = [raw, fields];
  while (pending.length) {
    const node = cardObject(pending.pop());
    if (!node || seen.has(node)) continue;
    seen.add(node); nodes.push(node);
    if (statistics) {
      statistics.cardNodes++;
      if (node.fields) statistics.cardShape |= 1;
      if (node.meta) statistics.cardShape |= 2;
      for (const [key, value] of Object.entries(node)) {
        if (destinations.includes(key)) statistics.cardShape |= 16;
        if (/preview|image|icon|cover|thumb/i.test(key)) statistics.cardShape |= 32;
        if (typeof value === 'string' && /^https?:\/\//i.test(value) && !destinations.includes(key)
          && !/preview|image|icon|cover|thumb|token|secret|auth|cookie/i.test(key)) statistics.cardOtherUrls++;
      }
    }
    for (const [key, child] of Object.entries(node).reverse()) {
      if (!/preview|image|icon|cover|thumb|token|secret|auth|cookie/i.test(key)) pending.push(child);
    }
  }
  // Inspect only delivered structured fields; image/preview URLs are not destinations.
  const links = [];
  for (const node of nodes) for (const key of destinations) {
    if (statistics && typeof node[key] === 'string' && node[key]) statistics.cardCandidates++;
    const url = publicCardLink(node[key], statistics);
    if (url && !links.includes(url)) links.push(url);
  }
  if (statistics) statistics.cardLinks = links.length;
  const first = keys => {
    for (const node of nodes) for (const key of keys) {
      const value = text(node[key], Infinity);
      if (value) return value;
    }
    return '';
  };
  return { source: 'qq_card_metadata', untrusted: true, name: text(raw.ark_name ?? raw.app, 100), type: text(raw.ark_type, 80),
    fields: cardFields(fields),
    prompt: text(raw.prompt, Infinity), title: first(['title']), description: first(['desc', 'description']),
    ...(links.length ? { url: links[0], links } : { linkStatus: 'NO_USABLE_LINK',
      limitation: 'No usable public HTTP(S) destination was found in the delivered card fields. Do not invent a link or treat a title/preview as page content.' }) };
}

// Retain unknown delivered fields as data, with credentials removed before storage.
function cardFields(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    let clean = text(value, Infinity);
    try {
      const url = new URL(clean);
      if (url.username || url.password) { url.username = ''; url.password = ''; }
      for (const key of url.searchParams.keys()) if (/token|secret|password|cookie|session|auth|signature|^key$/i.test(key)) url.searchParams.set(key, '[redacted]');
      if (/token|secret|password|cookie|session|auth/i.test(url.hash)) url.hash = '';
      clean = url.href;
    } catch { /* Ordinary strings stay verbatim after credential redaction. */ }
    return clean;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Repeated reference]';
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => cardFields(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /token|secret|password|cookie|authorization|^session$/i.test(key) ? '[redacted]' : cardFields(item, seen)]));
  seen.delete(value);
  return result;
}

function cardObject(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' ? value : null;
}

export function messageCardDiagnostics(message) {
  if (message.raw?.ark_data == null && (message.msgType ?? message.raw?.message_type) !== 3) return null;
  const statistics = { cardShape: 0, cardNodes: 0, cardCandidates: 0, cardLinks: 0,
    cardOtherUrls: 0, cardInvalid: 0, cardCredentials: 0, cardSensitive: 0 };
  const raw = message.raw?.ark_data;
  const card = messageCard(message, statistics);
  return { ...statistics, kind: raw == null ? 'absent' : typeof raw === 'string' ? 'json' : 'object',
    reason: !card ? raw == null ? 'CARD_DATA_ABSENT' : 'CARD_DATA_INVALID'
      : statistics.cardLinks ? 'CARD_LINK_AVAILABLE' : statistics.cardCandidates ? 'CARD_LINK_REJECTED' : 'CARD_DESTINATION_ABSENT' };
}

function publicCardLink(value, statistics) {
  if (typeof value !== 'string' || !value) return null;
  const reject = field => { if (statistics) statistics[field]++; return null; };
  if (value.length > 2048) return reject('cardInvalid');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return reject('cardInvalid');
    if (url.username || url.password) return reject('cardCredentials');
    if (redactQQMediaUrls(url.href) !== url.href) return reject('cardSensitive');
    if (/(?:token|secret|auth|key|sign|ticket|cookie)/i.test([...url.searchParams.keys()].join(' '))
      || /(?:token|secret|auth|key|sign|ticket|cookie)/i.test(url.hash)) return reject('cardSensitive');
    return redactCredentials(url.href);
  } catch { return reject('cardInvalid'); }
}

function missingBody(type, card) {
  return [101, 102].includes(type) || card && /multimsg|forward|聊天记录/i.test(`${card.name} ${card.type} ${card.prompt} ${card.title}`)
    ? { source: 'qq_embedded_messages', relation: type === 101 ? 'parallel' : 'forwarded', children: [], count: 0, status: 'BODY_NOT_DELIVERED',
      limitation: 'QQ只投递了容器或卡片，没有内层消息正文；不能展开或凭摘要猜测内容。' } : null;
}

// Decode only fields actually delivered by QQ. No guessed fetch endpoint or foreign-chat lookup.
export async function captureMessageElements(scope, message, save) {
  const root = rawMessageElements(message);
  const type = message.msgType ?? message.raw?.message_type;
  if (!root.length) return missingBody(type, messageCard(message));
  const seen = new WeakSet();
  let capturedNodes = 0;
  const rootId = scopeId(`${scope}:${message.messageId}`);
  const walk = async (elements, parentId, depth, path, parentType) => {
    // A delivered tree has no fixed depth cap; unwind the JS call stack before descending.
    await Promise.resolve();
    const children = []; const omitted = new Set();
    for (const [index, element] of elements.entries()) {
      if (!element || typeof element !== 'object' || Array.isArray(element)) { omitted.add('UNSUPPORTED_ELEMENT'); continue; }
      if (seen.has(element)) { omitted.add('REPEATED_ELEMENT'); continue; }
      seen.add(element); capturedNodes++;
      const nodePath = `${path}${index + 1}`;
      const id = `element:${rootId}:${scopeId(nodePath)}`;
      const rawText = normalizeQQText(element.content);
      const content = text(rawText, Infinity);
      const attachments = messageAttachments(element);
      const nested = Array.isArray(element.msg_elements) ? element.msg_elements : [];
      const nodeType = Number.isInteger(element.message_type) ? element.message_type : null;
      const card = messageCard({ raw: element });
      const captured = nested.length ? await walk(nested, id, depth + 1, `${nodePath}.`, nodeType)
        : missingBody(nodeType, card);
      const author = element.author && typeof element.author === 'object' ? element.author : {};
      const node = await save({ kind: message.kind, groupOpenid: message.groupOpenid, messageId: id,
        senderId: text(author.member_openid ?? author.user_openid ?? author.id, 200),
        senderName: text(author.username ?? author.nickname, 80), content, attachments,
        timestamp: typeof element.timestamp === 'string' ? element.timestamp : null,
        mentions: Array.isArray(element.mentions) ? element.mentions : [], msgType: nodeType,
        raw: element,
      }, { parentMessageId: parentId, depth, path: nodePath,
        reportedMessageId: text(element.id, 200) || null, reportedMessageIndex: text(element.msg_idx, 200) || null,
        elements: captured, card });
      if (captured?.status === 'TRUNCATED') omitted.add('NESTED_LIMIT');
      children.push({ messageId: node.messageId });
    }
    return { source: 'qq_embedded_messages',
      relation: ({ 101: 'parallel', 102: 'forwarded', 103: 'quote' })[parentType] ?? 'embedded',
      children, count: children.length,
      status: omitted.size ? 'TRUNCATED' : 'DELIVERED', ...(omitted.size ? { limitations: [...omitted] } : {}) };
  };
  const result = await walk(root, message.messageId, 1, '', type);
  return { ...result, capturedNodes, untrusted: true,
    limitation: nestedMessageLimitation };
}
