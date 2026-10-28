import { scopeId } from './policy.mjs';
import { RequestUpdates } from './request-updates.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { contentCodecs } from './content-codecs.mjs';
import './message-codecs.mjs';

// Own foreground inference queuing, progress and message-context preparation.
// Management commands never enter this path.
export class ForegroundRequests {
  constructor(controller) { this.controller = controller; }
  async enqueue({ who, message, text, reply, ignored }) {
    if (!who.private) throw new Error('FOREGROUND_PRIVATE_REQUIRED');
    const c = this.controller; const lane = c.lane(who.scope);
    if (lane.maintenance) { ignored('CONVERSATION_MAINTENANCE'); return; }
    const epoch = lane.epoch;
    const isCurrent = () => !c.closed && lane.epoch === epoch;
    const settings = who.admin ? await c.adminSettings.read(who.scope) : { toolMonitor: false };
    if (!isCurrent()) { ignored('ADMIN_CANCELLED'); return; }
    const updates = new RequestUpdates(settings, response => c.notifyAdmins({ scope: who.scope, requestId: message.requestId,
      reason: 'TASK_FEEDBACK', text: response.text, feedback: true, isActive: response.isActive }), lane.pending > 0, isCurrent);
    clearTimeout(lane.timer); lane.timer = null;
    const entry = lane.events.add(`request:${message.messageId}`, 'message', async () => {
      if (!isCurrent()) throw new Error('EVENT_TURN_EXPIRED');
      const checkpoint = await c.store.conversation(who.scope);
      if (checkpoint.seen.includes(message.messageId)) return { alreadySeen: true, messageId: message.messageId };
      const { messageContent, currentSpeaker } = await this.prepare(who, message);
      return { messageId: message.messageId, messageContent, currentSpeaker };
    }, async () => {
      await c.recordModelInput(who.scope, [message.messageId]);
    });
    lane.pending++;
    c.debug.record(who.scope, 'task_queued', { requestId: message.requestId });
    c.emit('state', { scope: scopeId(who.scope), state: 'message_queued', requestId: message.requestId, pending: lane.pending });
    const task = lane.tail.then(async () => {
      if (!isCurrent()) { ignored('ADMIN_CANCELLED'); return; }
      if (entry.supplied) return;
      lane.events.remove(entry);
      const checkpoint = await c.store.conversation(who.scope);
      if (checkpoint.seen.includes(message.messageId)) { ignored('ALREADY_SEEN'); return; }
      c.emit('state', { scope: scopeId(who.scope), state: 'message_started', requestId: message.requestId });
      c.debug.record(who.scope, 'task_started', { requestId: message.requestId });
      updates.update({ kind: 'started' });
      const { messageImages, messageContent, currentSpeaker } = await this.prepare(who, message);
      await c.run(who.scope, text, checkpoint, { onUpdate: event => updates.update(event), isCurrent,
        onReply: (content, isActive, media) => reply({ event: 'reply-part', text: content, media, isActive: () => isCurrent() && isActive() }),
        messageContent, messageImages, requestId: message.requestId,
        currentSpeaker, inputMessageIds: [message.messageId] });
      await updates.finish();
    }).catch(async error => {
      if (!isCurrent()) return;
      await updates.finish();
      await c.reportTaskFailure(who.scope, error, message.requestId);
    })
      .finally(async () => {
        try { await updates.close(); }
        finally {
          lane.events.remove(entry);
          lane.pending--;
          if (!lane.pending) for (const scope of c.lanes.keys()) c.schedule(scope);
          if (!c.foregroundPending()) await c.groupScheduler.resume();
        }
      });
    // Report this request's failure to its caller without poisoning later work.
    lane.tail = task.catch(() => {});
    return task;
  }
  async prepare(who, message) {
    const c = this.controller;
    const messageImages = message.images ?? await c.messageImages.capture(who.scope, message);
    message.images = messageImages;
    const speakerAdmin = who.admin;
    const record = message.structure ?? await c.messageRecords.capture(who.scope, message, speakerAdmin);
    if (!message.structure) c.recordMessageElements(who.scope, message.requestId, record);
    await assertMessageAccess(who.scope, c.store, record);
    if (!await c.messageRecords.find(who.scope, record.messageId)) throw new Error('MESSAGE_NOT_RETAINED');
    return { messageImages, messageContent: contentCodecs.value('message.record', record).to('message.content').single(),
      currentSpeaker: { name: record.speaker?.name || '昵称未提供', openid: message.senderId, isBotAdmin: speakerAdmin } };
  }
}
