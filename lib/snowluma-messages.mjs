import { fromCQString } from '@snowluma/sdk';
import { scopeId } from './policy.mjs';
import { isQQMediaUrl } from './qq-images.mjs';
import { messageAttachments, messageCard, normalizeQQText } from './message-elements.mjs';
import { qqId, snowIdentity, snowMessageId } from './snowluma-identity.mjs';

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8640000000000
    ? new Date(value * 1000).toISOString() : null;
}
function segments(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return fromCQString(value); } catch { return [{ type: 'text', data: { text: value } }]; }
  }
  return value && typeof value === 'object' && typeof value.type === 'string' ? [value] : [];
}
function format(parts) {
  if (parts.some(part => part.relation === 'forwarded')) return 102;
  if (parts.some(part => part.relation === 'quote')) return 103;
  return parts.some(part => part.type === 'card') ? 3 : 0;
}
function structured(type, data) {
  let value = data;
  if (type === 'json') {
    try { value = typeof data.data === 'string' ? JSON.parse(data.data) : data.data; } catch { value = data; }
  }
  if (!value || typeof value !== 'object') value = { value };
  return messageCard({ raw: { ark_data: { ...value, ark_name: value.app || type, fields: value } } });
}
// Translate only delivered segments. Neither this codec nor capture performs I/O
// to expand quotes/forwards, download media or inspect server filesystem paths.
export async function snowMessage(event, account) {
  if (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  if (qqId(event.self_id) !== qqId(account)) throw new Error('SNOWLUMA_ACCOUNT_MISMATCH');
  if (qqId(event.user_id) === qqId(account)) return null;
  const kind = event.message_type === 'group' ? 'group' : 'c2c';
  const message = { kind, messageId: snowMessageId(event.message_id), senderId: snowIdentity(account, event.user_id),
    senderName: typeof event.sender?.card === 'string' && event.sender.card ? event.sender.card : event.sender?.nickname,
    timestamp: timestamp(event.time), rawEventType: kind === 'group' ? 'SNOWLUMA_GROUP_MESSAGE' : 'SNOWLUMA_PRIVATE_MESSAGE',
    ...(kind === 'group' ? { groupOpenid: snowIdentity(account, event.group_id) } : {}),
    senderIsBot: false, botMentioned: false, msgType: 0, raw: {} };
  const decoded = await snowMessageContent(event.message, account, message);
  const { msg_elements, ...fields } = decoded;
  return { ...message, ...fields, msgType: format(fields.onebotParts), msgElements: msg_elements };
}

// Shared pure decoder for delivered events and explicitly acquired forward bodies.
async function snowMessageContent(value, account, message) {
  const seen = new WeakSet();
  const decode = async (value, owner) => {
    await Promise.resolve();
    const result = { content: '', attachments: [], mentions: [], msg_elements: [], onebotParts: [] };
    const parts = result.onebotParts;
    const addText = text => {
      if (typeof text !== 'string') return;
      const start = result.attachments.length;
      result.attachments = messageAttachments({ content: text, attachments: result.attachments });
      const clean = normalizeQQText(text); parts.push({ type: 'text', text: clean }); result.content += clean;
      for (let index = start; index < result.attachments.length; index++) parts.push({ type: 'attachment', index });
    };
    for (const segment of segments(value)) {
      if (!segment || typeof segment !== 'object') continue;
      if (seen.has(segment)) { parts.push({ type: 'reference', messageId: null, status: 'REPEATED_ELEMENT' }); continue; }
      seen.add(segment);
      const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
      if (segment.type === 'text' || segment.type === 'markdown') { addText(data.text ?? data.content); continue; }
      if (segment.type === 'face') { addText(`［QQ表情:${String(data.id ?? 'unknown')}${data.resultId != null ? ` result=${data.resultId}` : ''}］`); continue; }
      if (segment.type === 'at') {
        const bot = String(data.qq) === String(account);
        let id = null; try { id = snowIdentity(account, data.qq); } catch { /* Everyone or unknown target. */ }
        result.mentions.push({ id, nickname: typeof data.name === 'string' ? data.name : '', scope: data.qq === 'all' ? 'all' : undefined, is_you: bot });
        if (owner) message.botMentioned ||= bot;
        continue;
      }
      if (['image', 'record', 'video', 'file'].includes(segment.type)) {
        const type = { record: 'audio' }[segment.type] ?? segment.type;
        const url = [data.url, data.file].find(isQQMediaUrl);
        const index = result.attachments.length;
        result.attachments.push({ content_type: type, ...(url ? { url } : {}),
          filename: typeof data.name === 'string' && /^[^/\\:]{1,200}$/.test(data.name) ? data.name : typeof data.file === 'string' && /^[^/\\:]{1,200}$/.test(data.file) ? data.file : '',
          ...(Number.isFinite(data.size) && data.size >= 0 ? { size: data.size } : {}),
          ...(Number.isFinite(data.width) ? { width: data.width } : {}), ...(Number.isFinite(data.height) ? { height: data.height } : {}),
          ...(typeof data.asr === 'string' ? { asr_refer_text: data.asr } : {}) });
        parts.push({ type: 'attachment', index }); continue;
      }
      if (['node', 'forward', 'reply'].includes(segment.type)) {
        const inline = segment.type === 'reply' ? data.message : data.content;
        if (inline !== undefined) {
          const nodes = segment.type === 'forward' ? segments(inline) : [segment.type === 'node' ? segment : { type: 'node', data: { content: inline, user_id: data.qq, time: data.time } }];
          const start = result.msg_elements.length;
          for (const node of nodes) {
            const item = node?.type === 'node' ? node.data : null;
            if (!item || !('content' in item)) continue;
            const child = await decode(item.content, false);
            let user = ''; try { user = snowIdentity(account, item.user_id); } catch { /* Unknown stays unknown. */ }
            result.msg_elements.push({ ...child, author: { id: user, nickname: typeof item.nickname === 'string' ? item.nickname : '' },
              timestamp: timestamp(item.time), message_type: format(child.onebotParts) });
          }
          if (result.msg_elements.length > start) {
            parts.push({ type: 'children', start, count: result.msg_elements.length - start, relation: segment.type === 'reply' ? 'quote' : 'forwarded' });
            continue;
          }
        }
        let ref = null;
        if (segment.type === 'reply' && data.id != null) { try { ref = snowMessageId(data.id); } catch {} }
        // The native forward acquisition key remains outside model projections.
        // This opaque leaf deliberately has no synthetic body or traversal.
        if (!ref && data.id != null) ref = `forward:${scopeId(`${message.messageId}:${String(data.id)}`)}`;
        const resourceId = segment.type === 'forward' && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 2048 ? data.id : null;
        parts.push({ type: 'reference', messageId: ref, relation: segment.type === 'reply' ? 'quote' : 'forwarded',
          status: resourceId ? 'DETAIL_REQUIRED' : 'BODY_NOT_DELIVERED', ...(resourceId ? { resourceId } : {}) });
        continue;
      }
      // Cards and unknown extension segments retain all delivered fields with
      // the shared card sanitizer; URLs/credentials are never passed raw.
      const card = structured(segment.type || 'unknown', data);
      if (card) parts.push({ type: 'card', card });
    }
    return result;
  };
  return decode(value, true);
}

// SDK get_forward_msg returns message nodes. Unknown identities/times stay absent.
export async function snowForwardMessage(result, account, kind, messageId) {
  if (!Array.isArray(result?.messages) || !result.messages.length) throw new Error('FORWARD_BODY_UNAVAILABLE');
  const nodes = result.messages.map(row => {
    if (!row || typeof row !== 'object') throw new Error('FORWARD_BODY_UNAVAILABLE');
    if (row.type === 'node' && row.data?.content !== undefined) return row;
    if (row.message === undefined) throw new Error('FORWARD_BODY_UNAVAILABLE');
    return { type: 'node', data: { content: row.message, user_id: row.sender?.user_id,
      nickname: row.sender?.nickname, time: row.time } };
  });
  const message = { kind, messageId, senderId: '', raw: {} };
  const { msg_elements, ...fields } = await snowMessageContent(nodes, account, message);
  return { ...message, ...fields, msgType: 102, msgElements: msg_elements, forwardDetail: true };
}
