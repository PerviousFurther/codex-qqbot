import { WebAccessRequests } from './web-access-requests.mjs';
import { ChatContext } from './chat-context.mjs';
import { recordComponents } from './record.mjs';
import { resolveReplyMedia } from './reply-media.mjs';
import { ConversationEvents } from './conversation-events.mjs';
import { SavedImages } from './saved-images.mjs';
import { ChatRecords } from './chat-records.mjs';
import { SharedState } from './shared-state.mjs';
import { MessageRecords } from './message-records.mjs';
import { ReplyContacts } from './reply-contacts.mjs';
import { ReplyRouting } from './reply-routing.mjs';
import { assertReplyAccess } from './reply-access.mjs';
import { TaskControls } from './task-controls.mjs';
import { randomUUID } from 'node:crypto';
import { Diagnostics } from './diagnostics.mjs';
import { GroupScheduler } from './group-scheduler.mjs';
import { groupTaskAccess, groupPolicy } from './group-policy.mjs';
import { GroupSettings } from './group-settings.mjs';
import { BotCommands } from './commands.mjs';
import { PersonaSettings } from './persona.mjs';
import { History } from './history.mjs';
import { ContentCleanup } from './content-cleanup.mjs';
import { ChatAccess } from './chat-access.mjs';
import { MessageImages } from './message-images.mjs';
import { ConversationModels } from './conversation-models.mjs';
import { GroupContext } from './group-context.mjs';
import { recoveryFor } from './agent-diagnostics.mjs';
import { EventEmitter } from 'node:events';
import { GroupAccess } from './group-access.mjs';
import { GroupLifecycle } from './group-lifecycle.mjs';
import { ConversationMaintenance } from './conversation-maintenance.mjs';
import { AdminSettings, defaultPreferences } from './admin-settings.mjs';
import { MessageHandler } from './message-handler.mjs';
import { MediaManagement } from './media-management.mjs';
import { FileManagement } from './file-management.mjs';
import { ConversationRequests } from './conversation-requests.mjs';
import { GroupRuntime } from './group-runtime.mjs';
import { scopeId } from './policy.mjs';

export class VideoController extends EventEmitter {
  constructor({ adapter, store, admins, groups = [], browseDelayMs = 30000,
    compactEvery = 8, claimFirstAdmin = false }) {
    super();
    if (!Array.isArray(admins) || (!admins.length && !claimFirstAdmin)) throw new Error('ADMIN_IDENTITY_REQUIRED');
    if (!Number.isInteger(compactEvery) || compactEvery < 2) throw new Error('INVALID_COMPACTION_INTERVAL');
    Object.assign(this, { adapter, store, admins, groups, browseDelayMs, compactEvery });
    this.groupAccess = new GroupAccess(store, groups);
    this.history = new History(store); this.groupContext = new GroupContext(store); this.sharedState = new SharedState(store);
    this.messageImages = new MessageImages(store);
    this.messageRecords = new MessageRecords(store, this.messageImages);
    this.savedImages = new SavedImages(store);
    this.chatRecords = new ChatRecords(this);
    this.adminSettings = new AdminSettings(store);
    this.replyContacts = new ReplyContacts(store); this.replyRouting = new ReplyRouting(this);
    this.chatContext = new ChatContext(this);
    this.chatAccess = new ChatAccess(store);
    this.conversationModels = new ConversationModels({ adapter, store, event: event => this.emit('state', event) });
    this.personaSettings = new PersonaSettings(store);
    this.debug = new Diagnostics(store);
    store.onVideoRecordError = () => this.debug.record('system', 'video_record_corrupt_deleted', { reason: 'VIDEO_RECORD_CORRUPT', count: 1 });
    this.contentCleanup = new ContentCleanup(store, (stage, details) => this.debug.record('system', stage, details));
    this.groupRuntime = new GroupRuntime(this);
    this.groupSettings = new GroupSettings({ groups: this.groupAccess, changed: () => this.groupRuntime.configure(),
      clear: group => this.groupRuntime.clear(group), status: group => this.groupRuntime.status(group) });
    this.requests = new ConversationRequests(this);
    this.groupScheduler = new GroupScheduler({ loadGroup: id => this.groupAccess.read(id), status: group => this.groupContext.batchStatus(`group:${group.openid}`, { contextMinutes: groupPolicy(group).contextMinutes }),
      process: (group, trigger) => this.requests.process(group, trigger), busy: () => this.foregroundPending(),
      event: (group, stage, error) => this.debug.record(`group:${group.openid}`, stage, {
        reason: /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? '') ? error.message
          : /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code ?? '') ? error.code : 'GROUP_SCHEDULER_FAILED' }) });
    this.taskControls = new TaskControls({ groups: this.groupAccess, contacts: this.replyContacts, lane: scope => this.lane(scope), stop: scope => this.stopConversation(scope) });
    this.fileManagement = new FileManagement(this);
    this.mediaManagement = new MediaManagement(this);
    this.webAccessRequests = new WebAccessRequests(this);
    this.commands = new BotCommands(this);
    this.messages = new MessageHandler(this);
    this.adminReady = admins.length ? Promise.resolve() : store.firstAdmin().then(openid => {
      if (openid) this.admins = [openid];
    });
    this.lanes = new Map(); this.closed = false;
    this.groupLifecycle = new GroupLifecycle(this);
    this.conversationMaintenance = new ConversationMaintenance(this);
  }
  lane(scope) {
    if (!this.lanes.has(scope)) this.lanes.set(scope, { tail: Promise.resolve(), active: null, pending: 0, epoch: 0,
      events: new ConversationEvents(), interruptedWork: [],
      timer: null, paused: false, autobrowse: false, failures: 0, turns: 0, state: 'idle' });
    return this.lanes.get(scope);
  }
  state(scope, state) {
    this.lane(scope).state = state;
    this.emit('state', { scope: scopeId(scope), state });
  }
  async start() {
    await this.adminReady;
    await this.debug.start();
    await this.groupLifecycle.resume();
    await this.history.indexSavedContent();
    await this.contentCleanup.start();
    for (const openid of this.admins) {
      const scope = `c2c:${openid}`;
      this.lane(scope).allowProjectFiles = true;
      if ((await this.adminSettings.read(scope)).autobrowse) this.configureAutonomous(scope, true);
    }
    await this.groupRuntime.configure();
  }
  configureAutonomous(scope, enabled) {
    const lane = this.lane(scope);
    lane.autobrowse = enabled;
    lane.paused = !enabled;
    clearTimeout(lane.timer); lane.timer = null;
    if (!enabled && lane.active?.background) lane.active.controller.abort();
    if (!lane.active) this.state(scope, enabled ? 'idle' : 'paused');
    if (enabled) this.schedule(scope);
  }
  async reportTaskFailure(scope, error, requestId = error.requestId) {
    this.state(scope, 'error');
    // Adapter errors use fixed diagnostic names; never forward raw protocol dumps.
    const reason = /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message
      : /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_TASK_ERROR';
    const lane = this.lane(scope);
    const groupId = scope.startsWith('group:') ? scopeId(scope) : null;
    lane.lastFailure = reason;
    this.debug.record(scope, 'task_failed', { requestId, reason, httpStatus: error.upstreamStatus, rpcCode: error.rpcCode, agentCode: error.agentCode });
    const recovery = recoveryFor(error);
    if (recovery.kind === 'connection') await this.adapter.reset(scope);
    if (recovery.kind === 'context') {
      try { await this.adapter.compact(scope); }
      catch { await this.adapter.reset(scope); }
    }
    if (recovery.kind === 'blocked') {
      lane.paused = true; clearTimeout(lane.timer); lane.timer = null;
      if (scope.startsWith('c2c:') && lane.allowProjectFiles) {
        await this.adminSettings.update(scope, settings => { settings.autobrowse = false; });
        lane.autobrowse = false;
      }
      if (groupId) await this.groupAccess.update(groupId, group => { group.taskBlocked = reason; });
    }
    if (groupId) await this.groupAccess.update(groupId, group => { group.lastTaskFailure = reason; });
    const details = { scope: scopeId(scope), state: 'task_failed', reason,
      ...(Number.isInteger(error?.rpcCode) ? { rpcCode: error.rpcCode } : {}),
      ...(error?.agentCode ? { agentCode: error.agentCode } : {}),
      ...(Number.isInteger(error?.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) };
    this.emit('state', details);
    await this.notifyAdmins({ scope, requestId, reason, agentCode: error.agentCode, upstreamStatus: error.upstreamStatus });
  }
  async notifyAdmins({ scope = 'system', requestId }) {
    // The channel composition installs the notifier before accepting work.
    this.debug.record(scope, 'admin_notification_failed', { requestId, reason: 'ADMIN_TRANSPORT_UNAVAILABLE' });
  }
  async run(scope, text, checkpoint, { background = false, onUpdate = () => {},
    currentSpeaker = null, messageContent = null, messageImages = [], requestId = randomUUID(), purpose = 'conversation',
    onReply, inputMessageIds = [], isCurrent = () => true } = {}) {
    if (this.closed || this.lane(scope).maintenance || !isCurrent()) return;
    const lane = this.lane(scope);
    if (lane.active) throw new Error('CONVERSATION_BUSY');
    const turnEpoch = lane.epoch;
    const controller = new AbortController();
    lane.active = { controller, background, purpose, requestId };
    const accepted = []; let eventTurn; let completed = false;
    const rememberReply = (target, content, media) => {
      accepted.push({ target, text: content, media: !!media });
      if (accepted.length > 32) accepted.shift();
    };
    const previousWork = lane.interruptedWork;
    const suppliedMessageIds = [...inputMessageIds];
    this.state(scope, background ? 'browsing' : 'responding');
    try {
      // Scope is authoritative; context/capabilities cannot depend on scheduler initialization order.
      const groupRecord = scope.startsWith('group:') ? await this.groupAccess.read(scopeId(scope)) : null;
      if (scope.startsWith('group:') && !groupRecord?.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
      if (background && groupRecord && !groupTaskAccess(groupRecord, purpose).canRun) {
        this.debug.record(scope, 'group_task_skipped', { requestId, kind: purpose, reason: groupTaskAccess(groupRecord, purpose).reason });
        return;
      }
      const preferences = groupRecord?.ownerScope ? (await this.adminSettings.read(groupRecord.ownerScope)).preferences
        : lane.allowProjectFiles ? (await this.adminSettings.read(scope)).preferences : defaultPreferences();
      const groupContext = groupRecord?.listen && purpose === 'batch' ? await this.groupContext.snapshot(scope, { batch: true, contextMinutes: groupPolicy(groupRecord).contextMinutes }) : null;
      suppliedMessageIds.push(...(groupContext?.messages.map(row => row.messageId) ?? []));
      if (purpose === 'batch') for (const entry of lane.events.pending.values()) {
        if (entry.kind === 'group_batch') lane.events.remove(entry);
      }
      if (groupRecord) {
        const minutes = groupPolicy(groupRecord).contextMinutes;
        if (checkpoint.threadId && (checkpoint.groupContextMinutes !== minutes
          || !Number.isFinite(checkpoint.groupContextExpiresAt) || checkpoint.groupContextExpiresAt <= Date.now())) {
          await this.adapter.reset(scope);
          checkpoint.threadId = null;
        }
        const expiresAt = (groupContext?.oldestContextAt ?? Date.now()) + minutes * 60000;
        checkpoint.groupContextExpiresAt = checkpoint.threadId ? Math.min(checkpoint.groupContextExpiresAt, expiresAt) : expiresAt;
        checkpoint.groupContextMinutes = minutes;
        await this.store.saveConversation(scope, checkpoint);
      }
      const startedAt = new Date().toISOString();
      const activity = await this.store.activity(scope);
      const history = await this.history.records();
      const selected = history.find(video => (video.id ?? video.bvid) === (activity?.id ?? activity?.bvid));
      this.debug.record(scope, 'model_prepare', { requestId, kind: purpose });
      const active = () => !controller.signal.aborted && !this.closed && isCurrent();
      const backgroundReplies = background && groupTaskAccess(groupRecord, purpose).canReply;
      const canReply = !!onReply && (!background || backgroundReplies);
      eventTurn = lane.events.begin({ canReadMessages: canReply && purpose !== 'warmup',
        notices: previousWork.map(work => ({ kind: 'turn_interrupted', reason: work.reason, requestId: work.requestId,
          acceptedReplyCount: work.acceptedReplies.length })),
        wake: async status => {
          try { if (await this.adapter.steer?.(scope, status)) this.debug.record(scope, 'events_notified', { requestId, count: status.pendingCount }); }
          catch { this.debug.record(scope, 'event_notification_failed', { requestId, reason: 'EVENT_STEER_FAILED' }); }
        },
        interrupt: reason => {
          lane.active.interruptReason = reason;
          this.debug.record(scope, 'model_interrupt_requested', { requestId, reason }); controller.abort();
        } });
      const routing = canReply && (!background || purpose === 'batch') ? await this.replyRouting.session(scope, requestId, active, async () => {
        if (background && !groupTaskAccess(await this.groupAccess.read(scopeId(scope)), purpose).canReply) throw new Error('GROUP_SENDING_PAUSED');
      }) : null;
      const sharedState = await this.sharedState.read();
      const contextReader = canReply && (!background || purpose === 'batch') ? this.chatContext.session(scope, async () => {
        await assertReplyAccess(scope, this, active);
        if (background) {
          const current = await this.groupAccess.read(scopeId(scope));
          const owner = current?.pushOwner?.startsWith(`${requestId}:`) ? current.pushOwner : undefined;
          if (!groupTaskAccess(current, purpose, { owner }).canReply) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
        }
      }, requestId) : null;
      const result = await this.adapter.run({ scope, text, checkpoint, signal: controller.signal,
        onChatContext: contextReader ?? undefined,
        interruptedWork: previousWork,
        onInputAccepted: async () => {
          await this.recordModelInput(scope, suppliedMessageIds, groupContext?.epoch, turnEpoch);
          eventTurn.inputAccepted = true;
          if (groupRecord?.listen) await this.groupRuntime.notifyEvents(scope);
        },
        onEvents: async (timeoutSeconds = 0, requestSignal) => {
          await assertReplyAccess(scope, this, active);
          let ready = true;
          if (timeoutSeconds) {
            if (groupRecord && !groupTaskAccess({ ...await this.groupAccess.read(groupRecord.id), pushPending: false }, 'batch').canReply) {
              throw new Error('EVENT_MESSAGES_NOT_ALLOWED');
            }
            const waiting = new AbortController();
            try {
              const signal = AbortSignal.any([controller.signal, waiting.signal, ...(requestSignal ? [requestSignal] : [])]);
              const arrived = lane.events.wait(eventTurn, timeoutSeconds * 1000, signal);
              [ready] = await Promise.all([arrived, groupRecord?.listen ? this.groupRuntime.notifyEvents(scope) : undefined]);
            } finally { waiting.abort(); }
            if (requestSignal?.aborted) throw new Error('EVENT_TURN_EXPIRED');
            await assertReplyAccess(scope, this, active);
          }
          const events = await lane.events.read(eventTurn);
          for (const event of events.events) {
            const ids = event.data.messages?.map(row => row.messageId) ?? (event.data.messageId ? [event.data.messageId] : []);
            suppliedMessageIds.push(...ids);
          }
          suppliedMessageIds.splice(0, Math.max(0, suppliedMessageIds.length - 200));
          this.debug.record(scope, 'events_read', { requestId, count: events.events.length });
          if (groupRecord?.listen) await this.groupRuntime.notifyEvents(scope);
          return timeoutSeconds ? { ...events, timedOut: !ready && events.events.length === 0 } : events;
        },
        onTurnEnd: () => lane.events.finish(eventTurn),
        onWebDomainRequest: canReply && purpose !== 'warmup' ? async (host, requestSignal, statusOnly = false) => {
          const checkAccess = async () => {
            if (requestSignal?.aborted) throw new Error('WEB_APPROVAL_CANCELLED');
            await assertReplyAccess(scope, this, active);
            if (groupRecord) {
              const current = await this.groupAccess.read(scopeId(scope));
              const owner = current?.pushOwner?.startsWith(`${requestId}:`) ? current.pushOwner : undefined;
              const access = groupTaskAccess(current, purpose, { owner });
              if (!access.canReply) throw new Error(access.reason);
            }
          };
          try {
            if (statusOnly) return await this.webAccessRequests.status(host, checkAccess);
            const result = await this.webAccessRequests.request(host, { scope, isActive: active, checkAccess });
            this.debug.record(scope, 'web_access_requested', { requestId, kind: result.status });
            return result;
          } catch (error) {
            const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message ?? '') ? error.message : 'WEB_APPROVAL_FAILED';
            const canceled = ['REPLY_TURN_EXPIRED', 'WEB_APPROVAL_CANCELLED', 'GROUP_SENDING_PAUSED', 'GROUP_NOT_AUTHORIZED', 'PRIVATE_CHAT_DISABLED', 'CONVERSATION_MAINTENANCE', 'GROUP_SENDING_BUSY', 'COLLECTION_DISABLED', 'ENGAGE_DISABLED', 'GROUP_TASK_INVALID'].includes(reason);
            this.debug.record(scope, canceled ? 'web_access_canceled' : 'web_access_failed', { requestId, reason });
            if (!canceled && active()) await this.notifyAdmins({ scope, requestId, reason: 'WEB_APPROVAL_FAILED' });
            throw error;
          }
        } : undefined,
        onMediaEvent: async event => {
          await assertReplyAccess(scope, this, active);
          await lane.events.notify(eventTurn, event);
        },
        onGuard: async (enabled) => {
          await assertReplyAccess(scope, this, active);
          this.debug.record(scope, 'interrupt_guard_changed', { requestId, kind: enabled ? 'enabled' : 'disabled' });
          return lane.events.guard(eventTurn, enabled);
        },
        replyTargets: routing?.targets ?? (canReply ? [{ id: 'current', label: '当前群' }] : []),
        replyMode: background ? 'group' : 'foreground',
        onReply: canReply ? async (content, target = 'current', mediaSpec, bridgeActive = () => true) => {
          const sendingActive = () => active() && bridgeActive();
          this.debug.record(scope, 'reply_part_requested', { requestId, kind: background ? purpose : 'foreground' });
          try {
            await assertReplyAccess(scope, this, sendingActive);
            if (background && target !== 'current' && !routing) throw new Error('REPLY_TARGET_NOT_ALLOWED');
            if (target !== 'current' && mediaSpec?.attachment_id) throw new Error('CROSS_CONVERSATION_ATTACHMENT_DISABLED');
            let media;
            try {
              media = mediaSpec ? await resolveReplyMedia(scope, mediaSpec, this, sendingActive,
                { crossConversation: target !== 'current' }) : undefined;
            } catch (error) {
              if (mediaSpec?.type === 'image' && error.message === 'IMAGE_TOO_LARGE') error.replyNotSubmitted = true;
              throw error;
            }
            if (target === 'current') await onReply(content, sendingActive, media);
            else await routing.send(target, content, media, sendingActive);
            rememberReply(target, content, mediaSpec);
          } catch (error) {
            const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message ?? '') ? error.message : 'QQ_REPLY_FAILED';
            this.debug.record(scope, 'reply_part_failed', { requestId, reason, kind: background ? purpose : 'foreground' });
            throw error;
          }
        } : undefined,
        allowProjectFiles: !background && lane.allowProjectFiles,
        onUpdate, onDiagnostic: (stage, details) => {
          this.debug.record(scope, stage, { requestId, ...details });
          if (stage === 'model_error') void this.notifyAdmins({ scope, requestId, reason: 'CODEX_UPSTREAM_ERROR',
            agentCode: details.agentCode, upstreamStatus: details.httpStatus });
          if (stage === 'model_accepted' && lane.events.active === eventTurn) { eventTurn.woken = 0; lane.events.arm(); }
          if (stage === 'mcp_failed' && details.reason !== 'QQ_RATE_LIMITED'
            && !(details.reason === 'CHAT_CONTEXT_FAILED' && ['list_context_chats', 'read_chat_context'].includes(details.tool))
            && !(['WEB_DOMAIN_NOT_ALLOWED', 'WEB_APPROVAL_DENIED', 'WEB_APPROVAL_EXPIRED', 'WEB_APPROVAL_TIMEOUT'].includes(details.reason) && ['read_webpage', 'open_webpage', 'click_webpage', 'type_webpage', 'press_webpage', 'back_webpage', 'scroll_webpage', 'screenshot_webpage', 'get_webpage_dom', 'edit_webpage_dom'].includes(details.tool))) void this.notifyAdmins({ scope, requestId,
            reason: details.tool === 'send_reply' && ['QQ_REPLY_FAILED', 'QQ_PUSH_FAILED', 'GROUP_REPLY_STATE_WRITE_FAILED'].includes(details.reason)
              ? details.reason : `${details.tool ?? 'mcp'}:${details.reason ?? 'TOOL_FAILED'}` });
        },
        preferences, groupContext, sharedState, currentSpeaker, messageContent, messageImages, persona: await this.personaSettings.read(),
        memory: [...(selected ? [selected] : []), ...await this.store.context(scope, 8000), ...history.slice(0, 4)],
        onCheckpoint: async update => {
          Object.assign(checkpoint, update);
          await this.store.saveConversation(scope, checkpoint);
        },
      });
      if (!active()) return;
      if (!background && !result.replyAnswerSent && !result.replyRoutedSent && !result.replyDeliveryFailed && !result.replyCurrentRejected) {
        this.debug.record(scope, 'reply_skipped', { requestId, reason: 'MODEL_SILENT' });
      }
      if (!background && lane.allowProjectFiles && result.pauseBrowsing) {
        await this.adminSettings.update(scope, settings => { settings.autobrowse = false; });
        this.configureAutonomous(scope, false);
      }
      if (groupRecord) await this.groupAccess.update(groupRecord.id, group => { group.lastTaskFailure = null; });
      if (active() && !result.replyDeliveryFailed && result.sharedState !== null) {
        try { await this.sharedState.update(sharedState.revision, result.sharedState, active); }
        catch { await this.notifyAdmins({ scope, requestId, reason: 'SHARED_STATE_WRITE_FAILED' }); }
      }
      if (active() && !result.replyDeliveryFailed) {
        await lane.events.finish(eventTurn);
        completed = true; lane.interruptedWork = [];
      }
      lane.turns++;
      lane.failures = 0;
      lane.lastFailure = null;
      const compactRequest = groupRecord ? await this.groupContext.contextCompactionRequest(scope) : 0;
      if (!controller.signal.aborted && (compactRequest || lane.turns % this.compactEvery === 0)) {
        // Group-memory tools can request compaction, but the active turn must finish first.
        const abortCompaction = () => { this.adapter.reset(scope).catch(() => this.emit('state', {
          scope: scopeId(scope), state: 'compaction_cancel_failed' })); };
        controller.signal.addEventListener('abort', abortCompaction, { once: true });
        try {
          const compacted = await this.adapter.compact(scope);
          if (compacted && compactRequest) await this.groupContext.acknowledgeCompaction(scope, compactRequest);
        } catch (error) {
          if (!controller.signal.aborted) await this.reportTaskFailure(scope, error, requestId);
        } finally { controller.signal.removeEventListener('abort', abortCompaction); }
      }
      this.state(scope, lane.paused ? 'paused' : 'idle');
      return { ...result, requestId, startedAt, groupRevision: groupContext?.latestRevision ?? 0, groupEpoch: groupContext?.epoch ?? '',
        canFinishDelivery: () => !lane.events.available(eventTurn).some(entry => entry.kind === 'message') };
    } catch (error) {
      if (!controller.signal.aborted) throw Object.assign(error, { requestId });
      this.debug.record(scope, 'model_cancelled', { requestId, reason: lane.active?.interruptReason ?? 'ADMIN_CANCELLED' });
    } finally {
      if (controller.signal.aborted && lane.active?.interruptReason === 'NEW_MESSAGES' && !completed
        && lane.epoch === turnEpoch && !this.closed && !lane.maintenance) {
        lane.interruptedWork = [...previousWork, { reason: 'NEW_MESSAGES', purpose, messageIds: suppliedMessageIds,
          acceptedReplies: accepted, requestId }].slice(-4);
      }
      if (eventTurn) await lane.events.finish(eventTurn);
      await lane.inputTail;
      clearTimeout(lane.messageTimer); lane.messageTimer = null;
      lane.active = null;
    }
  }
  // Serialize input receipts separately from task/reply completion. Exact IDs
  // handle foreground mentions arriving out of order with ordinary group batches.
  recordModelInput(scope, messageIds, groupEpoch, laneEpoch = this.lane(scope).epoch) {
    const lane = this.lane(scope);
    const task = (lane.inputTail ?? Promise.resolve()).then(async () => {
      if (this.closed || lane.maintenance || lane.epoch !== laneEpoch) return;
      const ids = [...new Set(messageIds)];
      if (scope.startsWith('group:')) {
        const group = await this.groupAccess.read(scopeId(scope));
        if (!group?.allowed || lane.epoch !== laneEpoch || lane.maintenance || this.closed) return;
        if (group.listen && ids.length) {
          const epoch = groupEpoch ?? (await this.groupContext.batchStatus(scope)).epoch;
          await this.groupContext.markSupplied(scope, ids, epoch);
        }
      }
      if (ids.length) {
        const checkpoint = await this.store.conversation(scope);
        checkpoint.seen = [...new Set([...checkpoint.seen, ...ids])].slice(-200);
        await this.store.saveConversation(scope, checkpoint);
      }
    });
    lane.inputTail = task.catch(() => {}); return task;
  }
  recordMessageElements(scope, requestId, record) {
    const embedded = [...recordComponents(record)].find(item => ['record', 'record_ref'].includes(item.type) && item.source === 'qq_embedded_messages');
    if (embedded) this.debug.record(scope, 'message_elements_indexed', { requestId,
      reason: embedded.status, count: embedded.capturedNodes ?? embedded.count ?? 0 });
  }
  async stopConversation(scope, reason = 'ADMIN_STOPPED') {
    const lane = this.lane(scope);
    lane.epoch++; lane.paused = true; lane.autobrowse = false;
    lane.events.close(); lane.interruptedWork = [];
    clearTimeout(lane.messageTimer); lane.messageTimer = null;
    clearTimeout(lane.timer); lane.timer = null;
    lane.active?.controller.abort();
    this.debug.record(scope, 'task_cancelled', { reason: reason === 'ADMIN_STOPPED' ? 'ADMIN_CANCELLED' : reason });
    if (scope.startsWith('c2c:')) await this.replyContacts.block(scope);
    const release = this.adapter.reset(scope);
    const save = scope.startsWith('group:')
      ? this.groupAccess.update(scopeId(scope), group => { group.taskBlocked = reason; }).then(() => this.groupRuntime.configure())
      : this.adminSettings.update(scope, settings => { settings.autobrowse = false; });
    await Promise.all([release, save]);
    if (!lane.active || lane.active.controller.signal.aborted) this.state(scope, 'paused');
  }
  // Serialize administrator changes with turns in the target conversation, even when requested from private chat.
  async changeConversation(scope, change) {
    const lane = this.lane(scope); lane.pending++;
    if (lane.active?.background) lane.active.controller.abort();
    const task = this.requests.queue(scope, change);
    try { return await task; }
    finally { lane.pending--; if (!this.foregroundPending()) await this.groupScheduler.resume(); }
  }
  foregroundPending() { return [...this.lanes.values()].some(lane => lane.pending > 0); }
  schedule(scope) {
    const lane = this.lane(scope);
    if (scope.startsWith('group:')) return;
    if (this.closed || lane.maintenance || this.foregroundPending() || lane.paused || !lane.autobrowse || lane.pending || lane.timer || lane.active) return;
    const delay = lane.failures ? Math.min(600000, this.browseDelayMs * 2 ** Math.min(lane.failures, 5)) : this.browseDelayMs;
    lane.timer = setTimeout(() => {
      lane.timer = null;
      if (this.closed || this.foregroundPending() || lane.paused || !lane.autobrowse || lane.pending) return;
      this.requests.queue(scope, async () => {
        if (this.closed || this.foregroundPending() || lane.paused || !lane.autobrowse || lane.pending) return;
        await this.run(scope, 'Authorized autonomous discovery: use native web search and available webpage/media tools to find worthwhile public webpages, videos or audio matching the saved content preferences. Compare two or three different sources when useful; use fewer when evidence or access is limited. Read actual evidence and save relevant public facts with remember_content, including evidence gaps. Do not force a count or retry unavailable sources repeatedly. No current administrator request authorizes project reads or QQ output. The scheduler alone publishes saved public content under existing group permissions.',
          await this.store.conversation(scope), { background: true, purpose: 'discover' });
      }, async error => { lane.failures++; await this.reportTaskFailure(scope, error); }, () => this.schedule(scope))
        .catch(() => this.debug.record(scope, 'background_failed', { reason: 'BACKGROUND_FAILURE_REPORT_FAILED' }));
    }, delay);
    lane.timer.unref();
  }
  async close() {
    this.closed = true;
    this.groupScheduler.close();
    await this.contentCleanup.close();
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer); clearTimeout(lane.messageTimer); lane.events.close(); lane.active?.controller.abort();
    }
    await this.adapter.close();
    await Promise.allSettled([...this.lanes.values()].map(lane => lane.tail));
    await this.groupLifecycle.tail;
    await this.groupContext.close();
    await this.messageRecords.close();
    await this.messageImages.close();
    await this.debug.close();
  }
}
