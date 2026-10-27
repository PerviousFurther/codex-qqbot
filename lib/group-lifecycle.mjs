// Platform membership events revoke access before waiting for in-flight work to drain.
export class GroupLifecycle {
  constructor(controller) { this.controller = controller; this.tail = Promise.resolve(); }
  handle({ eventType, data, receivedAt }) {
    if (!['GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT'].includes(eventType)) return;
    const openid = data?.group_openid;
    if (typeof openid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(openid)) return;
    const timestamp = Number(data.timestamp);
    const at = Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : receivedAt;
    if (!Number.isFinite(at)) return;
    const work = this.tail.then(async () => {
      const c = this.controller;
      if (c.closed) return;
      const record = await c.groupAccess.membership(openid, eventType === 'GROUP_ADD_ROBOT', at);
      if (!record) return;
      if (record.leftAt) await this.cleanup(record);
      else {
        await c.groupRuntime.configure();
        c.debug.record(`group:${openid}`, 'group_joined');
      }
    });
    this.tail = work.catch(() => {});
    return work.catch(() => {
      this.controller.debug.record(`group:${openid}`, 'group_cleanup_failed', { reason: 'GROUP_LIFECYCLE_FAILED' });
      this.controller.emit('state', { state: 'group_lifecycle_failed', reason: 'GROUP_LIFECYCLE_FAILED' });
    });
  }
  async resume() {
    for (const record of await this.controller.groupAccess.departed()) await this.cleanup(record);
  }
  async cleanup(record) {
    const c = this.controller; const scope = `group:${record.openid}`; const lane = c.lane(scope);
    lane.epoch++; lane.paused = true; lane.autobrowse = false;
    lane.events.close(); lane.interruptedWork = [];
    clearTimeout(lane.messageTimer); lane.messageTimer = null;
    clearTimeout(lane.timer); lane.timer = null;
    lane.active?.controller.abort();
    await c.groupRuntime.configure();
    await c.adapter.reset(scope);
    await Promise.allSettled([lane.tail]);
    lane.tail = Promise.resolve();
    // Preparation may have finished opening a process during the first cancellation.
    await c.adapter.reset(scope);
    // Collection also uses this lock; access has already been revoked on disk.
    await c.groupAccess.serial(async () => {
      await c.chatRecords.remove(scope);
      const current = await c.store.read(c.groupAccess.path(record.id), null);
      if (current?.leftAt && current.membershipAt === record.membershipAt) {
        current.cleanupPending = false;
        await c.store.write(c.groupAccess.path(record.id), current);
      }
    });
    c.debug.record(scope, 'group_records_cleared');
  }
}
