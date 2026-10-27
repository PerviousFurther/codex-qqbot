import { scopeId } from './policy.mjs';

// Reused before model replies and before queued proactive sends; this grants no new access.
export async function assertReplyAccess(scope, { groupAccess, chatAccess, admins, closed, lanes }, isActive) {
  if (closed || (isActive && !isActive())) throw new Error('REPLY_TURN_EXPIRED');
  if (lanes?.get(scope)?.maintenance) throw new Error('CONVERSATION_MAINTENANCE');
  if (scope.startsWith('group:')) {
    if (!(await groupAccess.read(scopeId(scope)))?.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
  } else if (scope.startsWith('c2c:')) {
    if (!await chatAccess.accepts({ private: true, admin: admins.includes(scope.slice(4)) })) throw new Error('PRIVATE_CHAT_DISABLED');
  } else throw new Error('CONVERSATION_NOT_ALLOWED');
}
