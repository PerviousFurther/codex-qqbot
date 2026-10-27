import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeId } from './policy.mjs';
import { WorkspaceFiles } from './workspace-files.mjs';

// Main-process ownership: callers revoke access and drain model work before removal.
export class ChatRecords {
  constructor(controller) { this.controller = controller; }
  async clear(scope) {
    const c = this.controller;
    const lane = c.lane(scope);
    lane.events.close(); lane.interruptedWork = [];
    clearTimeout(lane.messageTimer); lane.messageTimer = null;
    if (scope.startsWith('group:')) await c.groupContext.clear(scope);
    await c.messageImages.clear(scope);
    await c.messageRecords.clear(scope);
    await c.savedImages.clear(scope);
    await WorkspaceFiles.clear(c.store, scope);
    if (scope.startsWith('c2c:')) await c.replyContacts.remove(scope);
    await rm(c.store.activityPath(scope), { force: true });
  }
  async remove(scope) {
    const c = this.controller;
    // Do not open/create databases during departure reconciliation.
    for (const [owner, directory] of [[c.groupContext, 'group-context'], [c.messageImages, 'message-images'], [c.messageRecords, 'message-records']]) {
      const pending = owner.connections.get(scope);
      owner.connections.delete(scope);
      if (pending) (await pending).close();
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(join(c.store.root, directory, `${scopeId(scope)}.sqlite${suffix}`), { force: true });
      }
    }
    await c.savedImages.clear(scope);
    await WorkspaceFiles.clear(c.store, scope);
    if (scope.startsWith('c2c:')) await c.replyContacts.remove(scope);
    for (const directory of ['runtime', 'group-admin-bindings']) {
      await rm(join(c.store.root, directory, scopeId(scope)), { recursive: true, force: true });
    }
    await rm(c.store.conversationPath(scope), { force: true });
    await rm(c.store.activityPath(scope), { force: true });
  }
}
