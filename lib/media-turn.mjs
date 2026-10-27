import { createConnection } from 'node:net';
import { callReplyBridge } from './reply-bridge.mjs';

// A private lifecycle subscription, not a model callback or an extra MCP tool.
// Turn completion waits for the MCP process to acknowledge actual cleanup.
export function watchMediaTurn(path, turnId, cleanup) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let input = '', accepted = false, cleaning;
    const lifetime = new AbortController();
    const clean = () => { lifetime.abort(); return cleaning ??= Promise.resolve().then(cleanup); };
    const timer = setTimeout(() => socket.destroy(new Error('MEDIA_TURN_UNAVAILABLE')), 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ action: 'watch_media_turn', turn_id: turnId }) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 4096) return socket.destroy(new Error('MEDIA_TURN_INVALID'));
      while (input.includes('\n')) {
        const pos = input.indexOf('\n'), line = input.slice(0, pos); input = input.slice(pos + 1);
        let value; try { value = JSON.parse(line); } catch { return socket.destroy(new Error('MEDIA_TURN_INVALID')); }
        if (!accepted) {
          if (!value.ok) return socket.destroy(new Error(value.code || 'MEDIA_TURN_EXPIRED'));
          accepted = true; clearTimeout(timer);
          resolve({ assertActive: () => {
            if (lifetime.signal.aborted || socket.destroyed) throw new Error('MEDIA_TURN_EXPIRED');
          }, check: async () => {
            if (socket.destroyed || cleaning) throw new Error('MEDIA_TURN_EXPIRED');
            const result = await callReplyBridge(path, { action: 'media_check', turn_id: turnId }, { signal: lifetime.signal, timeoutMs: 5000 });
            if (!result.ok) throw new Error(result.code);
          }, notify: async event => {
            if (socket.destroyed || cleaning) return;
            const result = await callReplyBridge(path, { action: 'media_event', turn_id: turnId, event }, { signal: lifetime.signal, timeoutMs: 5000 });
            if (!result.ok) throw new Error(result.code);
          }, close: () => { socket.destroy(); return clean(); } });
        } else if (value.event === 'turn_closed') {
          clean().then(() => { if (!socket.destroyed) socket.end('{"closed":true}\n'); }, () => socket.destroy());
        }
      }
    });
    socket.on('error', error => { if (!accepted) reject(error); });
    socket.on('close', () => { clearTimeout(timer); if (!accepted) reject(new Error('MEDIA_TURN_EXPIRED')); clean().catch(() => {}); });
  });
}

// Media decoding and temporary browser assets share the single acknowledged
// watcher allowed by ReplyBridge. Each owner still controls its own resources.
export class MediaTurnHub {
  constructor(watch = watchMediaTurn) { this.nativeWatch = watch; this.turns = new Map(); }
  async watch(path, turnId, cleanup) {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { owners: new Set(), closed: false }; this.turns.set(turnId, turn);
      turn.subscription = this.nativeWatch(path, turnId, async () => {
        turn.closed = true;
        const results = await Promise.allSettled([...turn.owners].map(owner => owner.clean()));
        this.turns.delete(turnId);
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
    }
    let cleaning;
    const owner = { clean: () => cleaning ??= Promise.resolve().then(cleanup) };
    turn.owners.add(owner);
    let subscription;
    try { subscription = await turn.subscription; }
    catch (error) { turn.owners.delete(owner); this.turns.delete(turnId); throw error; }
    if (turn.closed) { await owner.clean(); throw new Error('MEDIA_TURN_EXPIRED'); }
    return { ...subscription, close: async () => {
      turn.owners.delete(owner); await owner.clean();
      if (!turn.owners.size) await subscription.close();
    } };
  }
}
