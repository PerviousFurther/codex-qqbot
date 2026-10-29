import { snowRecipient } from './snowluma-identity.mjs';
import { assertMessageAccess } from './message-access.mjs';

export function validReplyInteraction(value) {
  return value && ['poke', 'reaction'].includes(value.type)
    && (/^slmsg~-?\d{1,20}$/.test(value.message_id ?? '')
      || value.type === 'poke' && /^slnotice~[0-9a-f-]{36}$/.test(value.message_id ?? ''))
    && Object.keys(value).every(key => ['type', 'message_id', 'emoji_id', 'set'].includes(key))
    && (value.type === 'poke' ? value.emoji_id === undefined && value.set === undefined
      : /^\d{1,10}$/.test(value.emoji_id ?? '') && (value.set === undefined || typeof value.set === 'boolean'));
}

// A top-level authenticated incoming record owns the target. Forwarded identities,
// cross-chat aliases and model-supplied QQ numbers never authorize interactions.
export async function resolveReplyInteraction(scope, spec, controller, checkSource) {
  if (!validReplyInteraction(spec)) throw new Error('REPLY_INTERACTION_INVALID');
  const account = /^\w+:sl~(\d+)~\d+$/.exec(scope)?.[1];
  if (!account) throw new Error('REPLY_INTERACTION_UNAVAILABLE');
  const group = scope.startsWith('group:');
  const notice = spec.message_id.startsWith('slnotice~');
  const messageId = notice ? null : Number(spec.message_id.slice(6));
  if (!notice && !Number.isSafeInteger(messageId)) throw new Error('REPLY_INTERACTION_INVALID');
  const read = async () => {
    await checkSource();
    const row = await controller.messageRecords.find(scope, spec.message_id);
    if (!row || row.source !== (notice ? 'qq_interaction_notice' : group ? 'qq_group_message' : 'qq_private_message') || row.embedded)
      throw new Error('INTERACTION_MESSAGE_UNAVAILABLE');
    await assertMessageAccess(scope, controller.store, row);
    if (!row.speaker?.openid) throw new Error('INTERACTION_SENDER_UNAVAILABLE');
    const sender = snowRecipient(account, row.speaker.openid);
    if (!group && row.speaker.openid !== scope.slice(4)) throw new Error('INTERACTION_SENDER_UNAVAILABLE');
    await checkSource();
    return sender;
  };
  const sender = await read();
  return { type: spec.type, messageId, sender, emojiId: spec.emoji_id, set: spec.set ?? true,
    assertAccess: async () => { if (await read() !== sender) throw new Error('INTERACTION_SENDER_UNAVAILABLE'); } };
}
