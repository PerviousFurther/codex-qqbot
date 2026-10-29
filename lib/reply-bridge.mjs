import { validReplyInteraction } from './reply-interaction.mjs';
import { approvalHost } from './web-access-state.mjs';
import { replyParts } from './reply-parts.mjs';
import { deliveryRateLimited, deliveryRateLimitDetails } from './delivery-errors.mjs';
import { SerialQueue } from './serial-queue.mjs';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redactCredentials } from './policy.mjs';

// Private IPC: the active authorized turn owns the allowed recipient aliases.
// No target OpenID, arbitrary path or QQ credentials are accepted from the model.
export class ReplyBridge {
  static async open() {
    const bridge = new ReplyBridge();
    bridge.directory = await mkdtemp(join(tmpdir(), 'watch-reply-'));
    bridge.path = join(bridge.directory, 'reply.sock');
    bridge.sockets = new Set();
    bridge.server = createServer(socket => bridge.receive(socket));
    try {
      await new Promise((accept, reject) => {
        bridge.server.once('error', reject);
        bridge.server.listen(bridge.path, accept);
      });
      await chmod(bridge.path, 0o600);
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }
  bind({ id, send, events, guard, mediaEvent, webDomainRequest, chatContext, onSkip = () => {} }) {
    if (this.active) throw new Error('REPLY_TURN_BUSY');
    const turn = { id, send, events, guard, mediaEvent, webDomainRequest, chatContext, onSkip, contextAbort: new AbortController(), contextTasks: new Set(), requestedDomains: new Map(), watchers: new Set(), attempts: new Map(), attemptedCount: 0, answerSent: 0, failed: false, queue: new SerialQueue() };
    this.active = turn;
    return { turn, close: () => {
      if (this.active === turn) this.active = null;
      turn.contextAbort.abort();
      return Promise.all([Promise.allSettled([...turn.contextTasks]), ...[...turn.watchers].map(watcher => watcher.close())]);
    } };
  }
  receive(socket) {
    this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
    const request = new AbortController();
    socket.on('close', () => request.abort());
    socket.on('error', () => {}); socket.setTimeout(70000, () => socket.destroy());
    let input = ''; let complete = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (complete) return;
      input += chunk;
      if (input.length > 1024 * 1024) { complete = true; socket.destroy(); return; }
      if (!input.includes('\n')) return;
      complete = true;
      Promise.resolve().then(() => {
        const args = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (args.action === 'watch_media_turn') return this.watch(socket, args.turn_id);
        return this.dispatch(args, request.signal);
      })
        .catch(error => ({ ok: false, code: /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'REPLY_FAILED', ...deliveryRateLimitDetails(error) }))
        .then(result => { if (result && !socket.destroyed) socket.end(JSON.stringify(result) + '\n'); });
    });
  }
  watch(socket, id) {
    const turn = this.active;
    if (!turn || turn.id !== id) throw new Error('REPLY_TURN_EXPIRED');
    if (turn.watchers.size) throw new Error('MEDIA_WATCH_ALREADY_BOUND');
    socket.setTimeout(0);
    let acknowledge, reject, timer, acknowledged = false;
    const done = new Promise((resolve, fail) => { acknowledge = resolve; reject = fail; });
    done.catch(() => {});
    const watcher = { close: () => {
      if (socket.destroyed) return done;
      if (!timer) {
        timer = setTimeout(() => { socket.destroy(); reject(new Error('MEDIA_CLEANUP_TIMEOUT')); }, 10000);
        socket.write('{"event":"turn_closed"}\n');
      }
      return done.finally(() => clearTimeout(timer));
    } };
    turn.watchers.add(watcher);
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      try { if (JSON.parse(input.slice(0, input.indexOf('\n'))).closed === true) { acknowledged = true; acknowledge(); socket.end(); } }
      catch { socket.destroy(); }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (acknowledged) turn.watchers.delete(watcher);
      else reject(new Error('MEDIA_CLEANUP_FAILED'));
    });
    socket.write('{"ok":true}\n');
  }
  dispatch({ turn_id: id, action = 'send', enabled, event, host, operation, message_id, query, since, until, cursor, offset, limit, timeout_seconds: timeoutSeconds = 30, part_id: partId, text = '', target = 'current', media, interaction }, signal) {
    const turn = this.active;
    if (!turn || turn.id !== id) throw new Error('REPLY_TURN_EXPIRED');
    if (action === 'chat_context' && turn.chatContext) {
      if (turn.failed) throw new Error('REPLY_TURN_EXPIRED');
      const contextSignal = AbortSignal.any([turn.contextAbort.signal, ...(signal ? [signal] : [])]);
      const task = Promise.resolve().then(() => turn.chatContext({ operation, message_id, target, query, since, until, cursor, offset, limit }, contextSignal)).then(result => {
        if (this.active !== turn || turn.failed || contextSignal.aborted) throw new Error('REPLY_TURN_EXPIRED');
        return { ok: true, ...result };
      });
      turn.contextTasks.add(task);
      void task.finally(() => turn.contextTasks.delete(task)).catch(() => {});
      return task;
    }
    if (action === 'check_pending_events' && turn.events) return turn.events();
    if (action === 'wait_reply' && turn.events) {
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error('EVENT_WAIT_TIMEOUT_INVALID');
      return turn.events(timeoutSeconds, signal);
    }
    if (action === 'set_interrupt_guard' && turn.guard) return turn.guard(enabled);
    if (action === 'web_domain_status' && turn.webDomainRequest) {
      approvalHost(host);
      if (!turn.requestedDomains.has(host)) throw new Error('TURN_ACTION_NOT_ALLOWED');
      return Promise.resolve(turn.webDomainRequest(host, signal, true)).then(result => {
        if (this.active !== turn || turn.failed || signal?.aborted) throw new Error('REPLY_TURN_EXPIRED');
        return { ok: true, ...result };
      });
    }
    if (action === 'web_domain_request' && turn.webDomainRequest) {
      approvalHost(host);
      if (turn.requestedDomains.has(host)) return turn.requestedDomains.get(host);
      if (turn.requestedDomains.size >= 3) return { ok: true, status: 'limited' };
      const task = Promise.resolve().then(() => turn.webDomainRequest(host, signal)).then(result => ({ ok: true, ...result }));
      turn.requestedDomains.set(host, task);
      return task;
    }
    if (action === 'media_check') return { ok: true };
    if (action === 'media_event' && turn.mediaEvent) {
      if (!event || !['media_ready', 'media_progress', 'media_error'].includes(event.kind)
        || !/^[a-f0-9]{32}$/.test(event.media_id ?? '') || !/^[a-f0-9]{32}$/.test(event.request_id ?? '')
        || !Number.isSafeInteger(event.frameCount) || event.frameCount < 0 || event.frameCount > 64
        || !['video', 'audio'].includes(event.track ?? 'video')
        || !Number.isSafeInteger(event.segmentCount ?? 0) || (event.segmentCount ?? 0) < 0 || (event.segmentCount ?? 0) > 100
        || event.kind === 'media_error' && !/^[A-Z][A-Z0-9_]{2,79}$/.test(event.code ?? '')) throw new Error('MEDIA_EVENT_INVALID');
      return Promise.resolve(turn.mediaEvent({ kind: event.kind, media_id: event.media_id, request_id: event.request_id,
        track: event.track ?? 'video', frameCount: event.frameCount, segmentCount: event.segmentCount ?? 0, ...(event.kind === 'media_error' ? { code: event.code } : {}) })).then(() => ({ ok: true }));
    }
    if (action !== 'send' || !turn.send) throw new Error('TURN_ACTION_NOT_ALLOWED');
    if (!Number.isSafeInteger(partId) || partId < 1) throw new Error('REPLY_PART_INVALID');
    if (typeof text !== 'string') throw new Error('REPLY_TEXT_INVALID');
    if (typeof target !== 'string' || !/^(current|admin:[1-9][0-9]*|(?:group|private):[a-f0-9]{32})$/.test(target)) throw new Error('REPLY_TARGET_INVALID');
    if (media && (typeof media !== 'object' || !['image', 'audio'].includes(media.type)
      || [media.attachment_id, media.asset_id, media.url, media.file_name].filter(Boolean).length !== 1
      || media.attachment_id && !/^[a-f0-9]{32}$/.test(media.attachment_id)
      || media.asset_id && (media.type !== 'image' || !/^[a-f0-9]{32}$/.test(media.asset_id))
      || media.file_name && (typeof media.file_name !== 'string' || media.file_name.length > 180 || media.file_name.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(media.file_name))
      || media.url && (typeof media.url !== 'string' || media.url.length > 2048))) throw new Error('REPLY_MEDIA_INVALID');
    if (interaction && (!validReplyInteraction(interaction) || target !== 'current' || text || media)) throw new Error('REPLY_INTERACTION_INVALID');
    const content = redactCredentials(text);
    const mediaKey = JSON.stringify(media ? { type: media.type, attachment_id: media.attachment_id, asset_id: media.asset_id, url: media.url, file_name: media.file_name } : null);
    const interactionKey = JSON.stringify(interaction ? { type: interaction.type, message_id: interaction.message_id, emoji_id: interaction.emoji_id, set: interaction.set ?? true } : null);
    const previous = turn.attempts.get(partId);
    if (previous) {
      if (previous.content !== content || previous.target !== target || previous.mediaKey !== mediaKey || previous.interactionKey !== interactionKey) throw new Error('REPLY_PART_CONFLICT');
      return previous.task;
    }
    if (partId !== turn.attempts.size + 1) throw new Error('REPLY_PART_OUT_OF_ORDER');
    const deadline = Date.now() + 60000;
    const isActive = () => this.active === turn && !turn.failed && Date.now() < deadline;
    const task = turn.queue.run(async () => {
      if (!isActive()) throw new Error('REPLY_TURN_EXPIRED');
      if (!content.trim() && !media && !interaction) {
        turn.onSkip({ reason: 'EMPTY_REPLY' });
        return { ok: true, sent: false, skipped: true, reason: 'EMPTY_REPLY', part_id: partId, target };
      }
      const parts = interaction ? [{ text: '', interaction }] : replyParts(content, media);
      turn.attemptedCount++;
      let sent = 0;
      try {
        for (const part of parts) {
          if (!isActive()) throw new Error('REPLY_TURN_EXPIRED');
          await turn.send(part.text, target, part.media, isActive, part.interaction);
          sent++;
          if (target === 'current') turn.answerSent++;
          else turn.routedSent = (turn.routedSent ?? 0) + 1;
        }
      } catch (error) {
        if (deliveryRateLimited(error)) {
          if (target === 'current') turn.currentRejected = true;
        } else if (!(sent === 0 && error.replyNotSubmitted === true && error.message === 'IMAGE_TOO_LARGE')) {
          turn.failed = true; turn.contextAbort.abort();
        }
        throw error;
      }
      return { ok: true, sent: true, messages_sent: interaction ? 0 : sent,
        ...(interaction ? { interactions_sent: sent } : {}), part_id: partId, target };
    });
    turn.attempts.set(partId, { content, target, mediaKey, interactionKey, task });
    return task;
  }
  close() {
    this.closing ??= (async () => {
      const turn = this.active;
      this.active = null;
      turn?.contextAbort.abort();
      for (const socket of this.sockets) socket.destroy();
      await Promise.allSettled([...(turn?.contextTasks ?? [])]);
      await new Promise(resolve => this.server.close(resolve));
      await rm(this.directory, { recursive: true, force: true });
    })();
    return this.closing;
  }
}

export function callReplyBridge(path, args, { signal, timeoutMs = 65000 } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('REPLY_TURN_EXPIRED'));
  return new Promise((accept, reject) => {
    const socket = createConnection(path); let input = ''; let settled = false;
    const abort = () => finish(new Error('REPLY_TURN_EXPIRED'));
    const finish = (error, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else accept(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('REPLY_DELIVERY_UNKNOWN')));
    socket.on('error', () => finish(new Error('REPLY_BRIDGE_UNAVAILABLE')));
    socket.on('connect', () => socket.write(JSON.stringify(args) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 262144) return finish(new Error('REPLY_BRIDGE_INVALID'));
      if (!input.includes('\n')) return;
      try { finish(null, JSON.parse(input.slice(0, input.indexOf('\n')))); }
      catch { finish(new Error('REPLY_BRIDGE_INVALID')); }
    });
    socket.on('end', () => { if (!input.includes('\n')) finish(new Error('REPLY_DELIVERY_UNKNOWN')); });
    socket.on('close', () => { if (!settled) finish(new Error('REPLY_DELIVERY_UNKNOWN')); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
