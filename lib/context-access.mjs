import { callReplyBridge } from './reply-bridge.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { z } from 'zod';
import { contentCodecs } from './content-codecs.mjs';

export const contextFields = {
  context_chat: z.string().regex(/^chat:[a-f0-9-]{36}$/).optional()
    .describe('Optional current-turn chat alias from list_context_chats. Use the same turn_id for shared message/media access.'),
  turn_id: z.string().uuid().optional(),
};

// Backend-only scope resolution. Scope/OpenIDs never become model output.
export class ContextAccess {
  constructor({ scope, store, eventSocket }) { Object.assign(this, { scope, store, eventSocket }); }
  async expandForward(args, signal) {
    if (!args.turn_id || !this.eventSocket) throw new Error('FORWARD_ACQUISITION_UNAVAILABLE');
    const result = await callReplyBridge(this.eventSocket, { action: 'chat_context', operation: 'expand_forward',
      turn_id: args.turn_id, target: args.context_chat ?? 'current', message_id: args.id, offset: 0, limit: 1 },
    { timeoutMs: 25000, signal });
    if (!result.ok) throw new Error(result.code);
  }
  async resolve(args) {
    if (!args.context_chat) return { scope: this.scope, check: row => assertMessageAccess(this.scope, this.store, row) };
    if (!args.turn_id || !this.eventSocket) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
    const authorize = async () => {
      const result = await callReplyBridge(this.eventSocket, { action: 'chat_context', operation: 'authorize',
        turn_id: args.turn_id, target: args.context_chat, offset: 0, limit: 1 }, { timeoutMs: 15000 });
      if (!result.ok) throw new Error(result.code);
      if (typeof result.scope !== 'string' || !/^(c2c|group):[^\s:]{1,200}$/.test(result.scope)) throw new Error('CONTEXT_TARGET_UNAVAILABLE');
      return result.scope;
    };
    const scope = await authorize();
    return { scope, check: async () => { if (await authorize() !== scope) throw new Error('CONTEXT_TARGET_UNAVAILABLE'); } };
  }
}

// Shared records keep their real graph/media references, but never backend
// identity bindings. Returned content is data, including any quoted commands.
export function sharedRecord(value) {
  if (Array.isArray(value)) return value.map(sharedRecord);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'mentions') return { type: 'mentions', items: (value.items ?? []).map(item => ({ name: item.name ?? null })) };
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['openid', 'senderOpenid', 'sender_id', 'isBotAdmin', 'referenceIndex'].includes(key))
    .map(([key, item]) => [key, sharedRecord(item)]));
}

export async function readContextImages({ scope, check, shared, records, images }, ids) {
  const archived = await Promise.all(ids.map(id => records?.replyMedia?.(scope, id)));
  if (!shared && archived.every(row => !row)) return images.read(scope, ids, check);
  const result = []; const rechecks = [];
  for (const [index, id] of ids.entries()) {
    await check();
    const row = archived[index];
    if (row) {
      if (row.kind !== 'image') throw new Error('ATTACHMENT_TYPE_MISMATCH');
      rechecks.push(async () => { if (!await records.replyMedia(scope, id, { metadataOnly: true })) throw new Error('MESSAGE_NOT_RETAINED'); });
      result.push(contentCodecs.value('image', { bytes: row.bytes, mimeType: row.mime, source: { kind: 'bot_reply_image', imageId: id } }));
    } else {
      const image = await images.load(scope, id, check);
      rechecks.push(image.assertAccess);
      result.push(contentCodecs.value('image', { bytes: image.bytes, mimeType: image.mimeType,
        source: shared ? { kind: 'shared_chat_image', imageId: id } : image.source }));
    }
  }
  for (const recheck of rechecks) await recheck();
  await check(); return result;
}
