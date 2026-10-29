import { join } from 'node:path';
import { ChatAccess } from './chat-access.mjs';
import { scopeId } from './policy.mjs';

// Shared by record retrieval, image reads and attachment sending.
export async function assertMessageAccess(scope, store, row) {
  if (scope.startsWith('group:')) {
    const group = await store.read(join(store.root, 'groups', `${scopeId(scope)}.json`), null);
    if (!group?.allowed || row?.historical && !group.listen) throw new Error('GROUP_MESSAGES_DISABLED');
  } else if (scope.startsWith('c2c:')) {
    const configured = (process.env.WATCH_ADMIN_IDS ?? process.env.WATCH_ADMIN_OPENIDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const admins = configured.length ? configured : [await store.firstAdmin()].filter(Boolean);
    if (!await new ChatAccess(store).accepts({ private: true, admin: admins.includes(scope.slice(4)) })) throw new Error('PRIVATE_CHAT_DISABLED');
  } else throw new Error('CONVERSATION_NOT_ALLOWED');
}
