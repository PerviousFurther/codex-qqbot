import { scopeId } from './policy.mjs';

// Shared delivery guard; recipient membership and stop checks remain with callers.
export async function assertDeliveryAccess(scope, { groupAccess, closed, lanes, acceptsChannelScope }, isActive) {
  if (acceptsChannelScope?.(scope) === false) throw new Error('CONVERSATION_NOT_ALLOWED');
  if (closed || (isActive && !isActive())) throw new Error('REPLY_TURN_EXPIRED');
  if (lanes?.get(scope)?.maintenance) throw new Error('CONVERSATION_MAINTENANCE');
  if (scope.startsWith('group:')) {
    if (!(await groupAccess.read(scopeId(scope)))?.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
  } else if (!scope.startsWith('c2c:')) throw new Error('CONVERSATION_NOT_ALLOWED');
}

// Input acceptance is checked for the source turn, not its outgoing recipients.
export async function assertReplyAccess(scope, controller, isActive) {
  await assertDeliveryAccess(scope, controller, isActive);
  if (scope.startsWith('c2c:') && !await controller.chatAccess.accepts({
    private: true, admin: controller.admins.includes(scope.slice(4)),
  })) throw new Error('PRIVATE_CHAT_DISABLED');
}
