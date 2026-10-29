import { principal } from './policy.mjs';
import { messageText } from './message-input.mjs';

// Authorize and classify input. Commands finish here; only chat enters inference.
export class MessageHandler {
  constructor(controller) { this.controller = controller; }
  ignored(message, reason) {
    const c = this.controller;
    const scope = message.kind === 'group' ? `group:${message.groupOpenid}` : `c2c:${message.senderId}`;
    c.emit('state', { state: 'message_ignored', requestId: message.requestId, reason });
    c.debug.record(scope, 'ignored', { requestId: message.requestId, reason });
  }
  async authorize(message, reply) {
    const c = this.controller;
    if (c.closed) return null;
    if (message.senderIsBot) { this.ignored(message, 'BOT_MESSAGE'); return null; }
    let allowedGroups = c.groups;
    if (message.kind === 'group' && message.groupOpenid && message.senderId && message.messageId) {
      const group = await c.groupAccess.observe(message.groupOpenid);
      if (!group.allowed || group.leftAt) { this.ignored(message, 'GROUP_NOT_AUTHORIZED'); return null; }
      c.groupRuntime.bind(group);
      allowedGroups = [message.groupOpenid];
    }
    let who;
    try { who = principal(message, c.admins, allowedGroups); }
    catch { this.ignored(message, 'CONVERSATION_NOT_ALLOWED'); return null; }
    if (!await c.chatAccess.accepts(who)) {
      this.ignored(message, 'PRIVATE_CHAT_DISABLED');
      if (!message.interactionNotice) await reply('机器人目前仅向机管开放私聊。'); return null;
    }
    return { who, reply };
  }
  async handle(message, reply) {
    const c = this.controller;
    const authorized = await this.authorize(message, reply);
    if (!authorized) return;
    const { who } = authorized;
    reply = authorized.reply;
    const text = messageText(message);
    if (!text) { this.ignored(message, 'EMPTY_CONTENT'); return; }
    c.lane(who.scope).allowProjectFiles = who.admin && who.private;
    try {
      if (await c.commands.dispatch({ who, message, text, reply })) return;
    } catch (error) { return c.reportTaskFailure(who.scope, error, message.requestId); }
    // Group discussion is owned by GroupRuntime, including bot mentions.
    if (!who.private) return;
    if (c.lane(who.scope).maintenance) { this.ignored(message, 'CONVERSATION_MAINTENANCE'); return; }
    if (!message.interactionNotice) await c.replyContacts.observe(message);
    return c.requests.enqueue({ who, message, text, reply,
      ignored: reason => this.ignored(message, reason) });
  }
}
