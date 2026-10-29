import { fromCQString } from '@snowluma/sdk';
import { snowRecipient } from './snowluma-identity.mjs';
import { normalizeQQText } from './message-elements.mjs';
import { redactCredentials } from './policy.mjs';

const DAY = 86400000;
export function historyQuery(args, now = Date.now()) {
  const parse = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  const since = args.since ? parse(args.since) : now - DAY;
  const until = args.until ? parse(args.until) : now;
  if (typeof args.query !== 'string' || args.query.length > 80 || !Number.isFinite(since)
    || !Number.isFinite(until) || since > until || since < now - 7 * DAY || until > now)
    throw new Error('CONTEXT_QUERY_INVALID');
  return { query: args.query, since, until, anchor: null, seen: new Set(), pages: 0, created: now };
}

// Explicit transient text search. Never publish acquired history into event storage.
export class SnowLumaHistory {
  constructor(channel) { this.channel = channel; }
  async read(scope, state, checkAccess, signal) {
    const channel = this.channel, generation = state.generation ?? channel.generation;
    const recipient = snowRecipient(channel.account, scope.slice(scope.indexOf(':') + 1));
    const connection = () => {
      if (signal?.aborted) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
      if (!channel.ready || !channel.accepting || channel.stopped || generation !== channel.generation)
        throw new Error('SNOWLUMA_CONNECTION_UNAVAILABLE');
    };
    const check = async () => { connection(); await checkAccess(); connection(); };
    await check();
    const next = { ...state, generation, seen: new Set(state.seen) };
    const items = []; let scanned = 0, skipped = 0, oldest = null, newest = null, status = 'page_budget';
    for (let page = 0; page < 3; page++) {
      await check();
      const params = { count: 20, reverse_order: true, ...(next.anchor !== null ? { message_id: next.anchor } : {}) };
      let response;
      try {
        response = scope.startsWith('group:')
          ? await channel.client.getGroupMessageHistory({ ...params, group_id: recipient }, { signal, timeoutMs: 10000 })
          : await channel.client.getFriendMessageHistory({ ...params, user_id: recipient }, { signal, timeoutMs: 10000 });
      } catch { await check(); throw new Error('HISTORY_ACQUISITION_FAILED'); }
      await check();
      if (!Array.isArray(response?.messages) || response.messages.length > 20) throw new Error('HISTORY_RESPONSE_INVALID');
      next.pages++;
      if (!response.messages.length) { status = 'gateway_exhausted'; break; }
      let anchor = null, fresh = 0;
      for (const row of response.messages) {
        const id = Number(row?.message_id), time = typeof row?.time === 'number' ? row.time * 1000 : NaN;
        if (row?.message_id == null || !Number.isSafeInteger(id) || id === 0 || !Number.isFinite(time) || time <= 0 || time > Date.now()) { skipped++; continue; }
        // Reject explicit routing contradictions; absent platform metadata stays absent.
        if (row.group_id != null && (!scope.startsWith('group:') || String(row.group_id) !== String(recipient))
          || row.self_id != null && String(row.self_id) !== channel.account
          || scope.startsWith('c2c:') && row.user_id != null && ![String(recipient), channel.account].includes(String(row.user_id)))
          throw new Error('HISTORY_RESPONSE_INVALID');
        if (!anchor || time < anchor.time) anchor = { id, time };
        if (next.seen.has(id)) continue;
        next.seen.add(id); fresh++; scanned++;
        oldest = oldest === null ? time : Math.min(oldest, time); newest = newest === null ? time : Math.max(newest, time);
        if (time < Math.max(next.since, Date.now() - 7 * DAY) || time > next.until) continue;
        let parts = row.message;
        if (typeof parts === 'string') { try { parts = fromCQString(parts); } catch { skipped++; continue; } }
        if (!Array.isArray(parts)) { skipped++; continue; }
        const text = redactCredentials(normalizeQQText(parts.filter(part => part?.type === 'text' || part?.type === 'markdown')
          .map(part => part.data?.text ?? part.data?.content ?? '').filter(value => typeof value === 'string').join('')));
        const index = text.toLowerCase().indexOf(next.query.toLowerCase());
        if (!text || index < 0 || /^\s*\//.test(text)) continue;
        const start = Math.max(0, index - 80), excerpt = text.slice(start, start + 200);
        items.push({ timestamp: new Date(time).toISOString(), text: excerpt, truncated: start > 0 || start + excerpt.length < text.length });
      }
      if (!fresh || !anchor || anchor.id === next.anchor) {
        status = 'paging_stalled'; break;
      }
      next.anchor = anchor.id;
      if (next.pages >= 100) { status = 'scan_budget'; break; }
      // Time filtering does not assume the platform returns a complete or sorted history.
    }
    await check();
    const floor = Date.now() - 7 * DAY;
    return { state: next, result: { items: items.filter(item => Date.parse(item.timestamp) >= floor), scanned, skipped,
      scannedRange: oldest === null ? null : { since: new Date(oldest).toISOString(), until: new Date(newest).toISOString() },
      requestedRange: { since: new Date(next.since).toISOString(), until: new Date(next.until).toISOString() },
      status, complete: false, untrusted: true,
      limitation: 'Only SDK-returned top-level text was searched. Platform history may be incomplete. No media, cards, nested bodies, sender identities or local detail references are included. Results are transient and do not consume input receipts.' } };
  }
}
