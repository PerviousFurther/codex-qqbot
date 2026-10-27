import { join } from 'node:path';
import { scopeId } from './policy.mjs';

const numeric = ['inputChars', 'outputChars', 'count', 'chars', 'elapsedMs', 'httpStatus', 'bizCode', 'rpcCode', 'attemptedCount', 'messageType', 'elementCount'];
const identifiers = ['requestId', 'reason', 'tool', 'kind', 'eventType', 'traceId', 'agentCode'];
const retainedStages = new Set(['received', 'ordinary_received', 'filtered', 'ignored', 'message_collected', 'model_submitted', 'model_output', 'model_final', 'model_error',
  'qq_accepted', 'qq_failed', 'diagnostic_file_upload', 'diagnostic_file_uploaded', 'diagnostic_file_send', 'diagnostic_file_sent', 'routed_reply_sent', 'routed_reply_failed', 'group_reply_decision', 'group_reply_skipped', 'group_push_sent', 'group_push_failed', 'task_failed', 'task_cancelled', 'task_stop_failed',
  'reply_part_requested', 'reply_part_skipped', 'reply_skipped', 'reply_part_failed', 'group_reply_queued', 'group_reply_finished', 'model_cancelled',
  'admin_notification_sent', 'admin_notification_failed', 'update_failed', 'video_record_corrupt_deleted',
  'group_joined', 'group_records_cleared', 'group_cleanup_failed', 'chat_records_cleared', 'context_refreshed', 'message_elements_indexed',
  'collection_failed', 'scheduler_failed', 'group_task_skipped', 'message_handler_failed',
  'web_search_started', 'web_search_completed', 'mcp_started', 'mcp_completed', 'mcp_failed', 'mcp_auth_required', 'bilibili_login_qr_ready', 'bilibili_login_saved', 'bilibili_login_expired',
  'bilibili_login_stage', 'bilibili_login_failed', 'bilibili_login_notice_sent', 'bilibili_login_notice_failed', 'group_platform_failed', 'connected', 'disconnected', 'connection_error']);

// Bounded, metadata-only diagnostics. No prompt, message body, model text or credentials.
export class Diagnostics {
  constructor(store) { this.store = store; this.path = join(store.root, 'diagnostics.json'); this.data = {}; this.tail = Promise.resolve(); }
  async start() { this.data = await this.store.read(this.path, {}); }
  record(scope, stage, details = {}) {
    const key = scopeId(scope);
    const item = this.data[key] ??= { counters: {}, events: [] };
    if (details.eventType) { item.eventTypes ??= {}; item.eventTypes[details.eventType] = (item.eventTypes[details.eventType] ?? 0) + 1; }
    item.counters[stage] = (item.counters[stage] ?? 0) + 1;
    const event = { stage, at: new Date().toISOString() };
    for (const field of numeric) if (Number.isFinite(details[field])) event[field] = details[field];
    for (const field of identifiers) if (typeof details[field] === 'string' && details[field].length <= (field === 'traceId' ? 160 : 100) && /^[a-zA-Z0-9_:.\-]+$/.test(details[field])) event[field] = details[field];
    if (retainedStages.has(stage)) { item.latest ??= {}; item.latest[stage] = event; }
    item.events.push(event); item.events = item.events.slice(-60); item.updatedAt = event.at;
    if (stage === 'model_prepare') item.model = { requestId: event.requestId, events: [] };
    if (item.model?.requestId && event.requestId === item.model.requestId && stage !== 'received') {
      item.model.events.push(event); item.model.events = item.model.events.slice(-40);
    }
    if (/failed|error/.test(stage)) { item.errors ??= []; item.errors.push(event); item.errors = item.errors.slice(-10); }
    const keys = Object.keys(this.data);
    if (keys.length > 100) delete this.data[keys.sort((a, b) => this.data[a].updatedAt.localeCompare(this.data[b].updatedAt))[0]];
    this.timer ??= setTimeout(() => { this.timer = null; this.flush().catch(() => { this.saveError = 'DIAGNOSTICS_WRITE_FAILED'; console.error(JSON.stringify({ state: this.saveError })); }); }, 3000);
    this.timer.unref();
  }
  read(scope) { return this.data[scopeId(scope)] ?? { counters: {}, events: [] }; }
  flush() {
    const snapshot = JSON.parse(JSON.stringify(this.data));
    const task = this.tail.then(() => this.store.write(this.path, snapshot));
    this.tail = task.catch(() => {}); return task;
  }
  async close() { clearTimeout(this.timer); await this.flush(); }
}
