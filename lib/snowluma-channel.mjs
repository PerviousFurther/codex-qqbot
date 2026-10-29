import { SnowLumaDrain } from './snowluma-drain.mjs';
import { randomUUID } from 'node:crypto';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { snowMessage } from './snowluma-messages.mjs';
import { qqId, snowIdentity, snowRecipient } from './snowluma-identity.mjs';
import { SnowLumaTransport, snowEndpoint } from './snowluma-transport.mjs';
import { ChatDelivery } from './chat-delivery.mjs';
import { ChatResponse } from './chat-response.mjs';
import { DeliveryDiagnostics } from './delivery-errors.mjs';
import { AdminNotifications } from './admin-notifications.mjs';
import { GroupPush } from './group-push.mjs';
import { assertDeliveryAccess } from './reply-access.mjs';
import { isCommandText } from './message-input.mjs';
import { scopeId } from './policy.mjs';

export class SnowLumaChannel {
  constructor({ account, wsUrl, wsToken, httpUrl, httpToken, controller, onState = () => {}, client, transport }) {
    this.account = qqId(account); this.controller = controller; this.onState = onState;
    if (!wsToken?.trim()) throw new Error('SNOWLUMA_TOKEN_REQUIRED');
    this.client = client ?? new SnowLumaWebSocketClient({ url: snowEndpoint(wsUrl, 'ws:'), accessToken: wsToken,
      requestTimeoutMs: 15000, reconnect: { minDelayMs: 1000, maxDelayMs: 30000 } });
    const sender = transport ?? new SnowLumaTransport({ account, url: httpUrl, token: httpToken });
    this.pending = new Set(); this.seen = new Map(); this.ready = false; this.accepting = false; this.stopped = false;
    controller.transportReady = false;
    controller.acceptsChannelScope = scope => {
      try { const [kind, id, extra] = scope.split(':');
        if (extra || !['c2c', 'group'].includes(kind)) return false;
        snowRecipient(this.account, id); return true;
      } catch { return false; }
    };
    this.generation = 0; this.resetting = Promise.resolve(); this.sends = 0;
    this.drain = new SnowLumaDrain({
      busy: () => !this.ready || this.pending.size > 0 || this.sends > 0
        || [...controller.lanes.values()].some(lane => lane.active || lane.pending)
        || [...controller.groupScheduler.entries.values()].some(entry => entry.running),
      pause: () => { controller.draining = true; },
      seal: async () => { this.ready = false; controller.transportReady = false; await this.closeConnection(); await this.resetting; },
      resume: async () => {
        controller.draining = false;
        if (this.stopped) return;
        if (!this.ready) await this.start();
        await controller.groupScheduler.resume();
        for (const scope of controller.lanes.keys()) controller.schedule(scope);
      }
    });
    this.diagnostics = new DeliveryDiagnostics();
    this.delivery = new ChatDelivery({ transport: async (...args) => {
      this.sends++;
      try { return await sender.send(...args); } finally { this.sends--; }
    }, diagnostics: this.diagnostics, onState,
      assertCanContinue: target => assertDeliveryAccess(`${target.scope}:${target.targetId}`, controller,
        () => this.ready && this.accepting && !this.stopped),
      historyEpoch: scope => controller.lane(scope).epoch,
      rememberReply: async (scope, content, result, epoch) => {
        const check = async () => {
          const lane = controller.lane(scope);
          if (lane.maintenance || lane.epoch !== epoch) throw new Error('REPLY_HISTORY_SCOPE_CLOSED');
          if (scope.startsWith('group:')) {
            const group = await controller.groupAccess.read(scopeId(scope));
            if (!group?.allowed || !group.listen) throw new Error('REPLY_HISTORY_SCOPE_CLOSED');
          }
        };
        await check(); await controller.messageRecords.captureReply(scope, content, result, check);
      }, notifyAdmins: report => controller.notifyAdmins(report) });
    const notifications = new AdminNotifications(controller, this.delivery);
    controller.notifyAdmins = report => notifications.send(report);
    controller.sendRoutedReply = (scope, text, isActive, beforeSend, media, beforeCommit) =>
      this.delivery.send(scope, { text, media }, { isActive, beforeSend, beforeCommit, history: true });
    controller.groupPublisher = new GroupPush(controller.groupAccess, controller.groupContext,
      (id, text, { media, ...options } = {}) => this.delivery.send(`group:${id}`, { text, media }, { ...options, history: true }),
      error => this.diagnostics.format('群消息发送失败', error), (state, { scope, ...details }) => {
        controller.debug.record(scope, state, { requestId: details.requestId, kind: details.kind, reason: details.reason,
          count: details.count, attemptedCount: details.attemptedCount });
        if (state === 'group_push_failed') this.track((async () => {
          await controller.stopConversation(scope, 'SEND_FAILED');
          await controller.notifyAdmins({ scope, requestId: details.requestId, reason: 'QQ_PUSH_FAILED' });
        })());
      }, error => this.diagnostics.errorDetails(error));
    this.client.on('open', () => {
      this.verification = this.verify(this.generation);
      this.track(this.verification);
    });
    this.client.on('close', () => this.disconnected());
    this.client.on('error', () => this.report('SNOWLUMA_CONNECTION_ERROR'));
    this.client.onEvent(event => this.track(this.receive(event)));
  }
  report(reason) {
    this.onState('channel_error', { reason });
    this.controller.debug.record('system', 'connection_error', { reason });
  }
  track(task) {
    this.pending.add(task);
    void task.catch(() => this.report('SNOWLUMA_EVENT_FAILED')).finally(() => this.pending.delete(task));
    return task;
  }
  async verify(generation) {
    try {
      await this.resetting;
      const info = await this.client.getLoginInfo();
      if (generation !== this.generation || this.stopped) return;
      if (this.stopped || qqId(info.user_id) !== this.account) throw new Error('SNOWLUMA_ACCOUNT_MISMATCH');
      this.ready = true;
      if (this.accepting) {
        this.controller.transportReady = true;
        await this.controller.groupRuntime.configure();
        for (const admin of this.controller.admins) {
          const scope = `c2c:${admin}`;
          const lane = this.controller.lane(scope);
          if (lane.autobrowse && !lane.paused) this.controller.schedule(scope);
        }
      }
      this.onState('connected'); this.controller.debug.record('system', 'connected');
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.ready = false; this.controller.transportReady = false;
      if (this.accepting && error.message !== 'SNOWLUMA_ACCOUNT_MISMATCH' && this.client.isConnected) {
        clearTimeout(this.verifyTimer);
        this.verifyTimer = setTimeout(() => this.track(this.verify(this.generation)), 15000);
        this.verifyTimer.unref();
      } else this.client.close();
      throw new Error('SNOWLUMA_ACCOUNT_VERIFICATION_FAILED');
    }
  }
  disconnected() {
    clearTimeout(this.verifyTimer);
    this.generation++; const resets = [];
    this.ready = false; this.controller.transportReady = false;
    for (const [scope, lane] of this.controller.lanes ?? []) {
      lane.epoch++; lane.events.close(); lane.interruptedWork = [];
      clearTimeout(lane.messageTimer); lane.messageTimer = null;
      clearTimeout(lane.timer); lane.timer = null;
      lane.active?.controller.abort();
      // Invalidate old output without changing saved feature/stop preferences.
      resets.push(this.controller.adapter.reset(scope));
    }
    this.resetting = Promise.allSettled(resets); this.track(this.resetting);
    this.onState('disconnected'); this.controller.debug.record('system', 'disconnected');
  }
  async receive(event) {
    const generation = this.generation;
    const admitted = () => !this.stopped && this.accepting && this.ready && generation === this.generation;
    if (!admitted() || String(event?.self_id) !== this.account) return;
    if (event.post_type === 'message' || event.post_type === 'notice') await this.drain.arrival();
    if (!admitted()) return;
    if (event.post_type === 'notice' && ['group_increase', 'group_decrease'].includes(event.notice_type)
      && String(event.user_id) === this.account && typeof event.time === 'number' && event.time > 0) {
      return this.controller.groupLifecycle.handle({ groupId: snowIdentity(this.account, event.group_id),
        joined: event.notice_type === 'group_increase', at: event.time * 1000 });
    }
    const message = await snowMessage(event, this.account);
    if (!message || !admitted()) return;
    const scope = message.kind === 'group' ? `group:${message.groupOpenid}` : `c2c:${message.senderId}`;
    const key = `${scope}:${message.messageId}`; const now = Date.now();
    for (const [id, at] of this.seen) if (now - at > 60000) this.seen.delete(id); else break;
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
    message.requestId = randomUUID();
    this.controller.debug.record(scope, 'received', { requestId: message.requestId, inputChars: message.content.length, eventType: message.rawEventType });
    // Collect delivered discussion before any mention decision. Commands reach
    // backend dispatch independently of the model queue and never enter memory.
    await this.controller.groupRuntime.observe(message);
    if (!admitted()) return;
    if (message.kind === 'group' && !isCommandText(message.content)) return;
    const response = new ChatResponse({ message, delivery: this.delivery, debug: this.controller.debug, onState: this.onState });
    try { await this.controller.messages.handle(message, value => response.send(value)); }
    catch (error) { await response.handlerFailed(error); }
    finally {
      await response.finish();
      if (response.failed && message.kind === 'group') await this.controller.stopConversation(scope, 'SEND_FAILED');
    }
  }
  async closeConnection() {
    if (!this.client.isConnected) { this.client.close(); return; }
    await new Promise((resolve, reject) => {
      const off = this.client.once('close', () => { clearTimeout(timer); resolve(); });
      const timer = setTimeout(() => { off(); reject(new Error('SNOWLUMA_CLOSE_TIMEOUT')); }, 10000);
      this.client.close();
    });
  }
  async start() {
    await this.client.connect(); await this.verification;
    if (!this.ready || this.stopped) throw new Error('SNOWLUMA_CONNECTION_UNAVAILABLE');
  }
  async activate() {
    if (!this.ready || this.stopped) throw new Error('SNOWLUMA_CONNECTION_UNAVAILABLE');
    this.accepting = true; this.controller.transportReady = true;
    await this.controller.groupRuntime.configure();
    for (const admin of this.controller.admins) this.controller.schedule(`c2c:${admin}`);
  }
  async stop() {
    clearTimeout(this.verifyTimer);
    this.stopped = true; this.ready = false; this.accepting = false;
    this.controller.transportReady = false; this.client.close();
    await Promise.allSettled([...this.pending]);
  }
}
