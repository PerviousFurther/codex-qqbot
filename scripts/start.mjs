import { configureWebAccess } from '../lib/web-access-policy.mjs';
import { GroupPlatform } from '../lib/group-platform.mjs';
import { GroupPush } from '../lib/group-push.mjs';
import { Store } from '../lib/store.mjs';
import { CodexAdapter } from '../lib/codex-adapter.mjs';
import { VideoController } from '../lib/controller.mjs';
import { QQChannel } from '../lib/qq-channel.mjs';

process.umask(0o077);
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
const dataDir = process.env.WATCH_DATA_DIR ?? '.state';
const store = new Store(dataDir);
configureWebAccess(store.root);
const configuredAdmins = list(process.env.WATCH_ADMIN_OPENIDS);
const savedAdmin = configuredAdmins.length ? null : await store.firstAdmin();
const admins = configuredAdmins.length ? configuredAdmins : savedAdmin ? [savedAdmin] : [];
const claimFirstAdmin = (process.env.WATCH_CLAIM_FIRST_ADMIN ?? 'true') === 'true';
const adapter = new CodexAdapter({ dataDir, codexHome: process.env.WATCH_CODEX_HOME ?? '.auth/codex' });
const controller = new VideoController({ adapter, store, admins, groups: list(process.env.WATCH_GROUP_OPENIDS),
  claimFirstAdmin });
controller.on('state', event => console.error(JSON.stringify(event)));
let channel;
let closing = false;
async function close() { if (!closing) { closing = true; channel?.stop(); await controller.close(); } }
process.once('SIGINT', close);
process.once('SIGTERM', close);

channel = new QQChannel({ appId: process.env.QQBOT_APP_ID, appSecret: process.env.QQBOT_APP_SECRET,
  transport: process.env.QQBOT_TRANSPORT ?? 'websocket', webhookPort: Number(process.env.QQBOT_WEBHOOK_PORT ?? 8080),
  menuEnabled: (process.env.QQBOT_MENU_ENABLED ?? 'true') === 'true',
  markdown: (process.env.QQBOT_MARKDOWN ?? 'true') === 'true',
  apiBaseUrl: process.env.QQBOT_API_BASE_URL ?? 'https://api.bot.qq.com',
  controller, store, onState: (state, details = {}) => console.error(JSON.stringify({ channel: 'qq', state, ...details })) });
controller.sendRoutedReply = (scope, text, isActive, beforeSend, media, beforeCommit) =>
  channel.delivery.send(scope, { text, media }, { isActive, beforeSend, beforeCommit, history: true });
controller.groupSettings.platform = new GroupPlatform({
  groups: controller.groupAccess,
  query: (openid, endpoint) => channel.diagnostics.call(() => channel.bot.api.get(`/v2/groups/${encodeURIComponent(openid)}/${endpoint}`)),
  formatError: error => channel.diagnostics.format(error.message === 'INVALID_QQ_GROUP_RESPONSE' ? '群接口响应格式异常' : '群接口查询失败', error),
  record: (group, error) => controller.debug.record(`group:${group.openid}`, 'group_platform_failed',
    { reason: 'QQ_GROUP_QUERY_FAILED', ...channel.diagnostics.errorDetails(error) }),
});
const pushes = new GroupPush(controller.groupAccess, controller.groupContext, (openid, text, { media, ...options } = {}) => channel.delivery.send(`group:${openid}`, { text, media }, { ...options, history: true }),
  error => channel.diagnostics.format('群推送失败', error),
  (state, { scope, ...details }) => {
    console.error(JSON.stringify({ channel: 'qq', state, ...details }));
    controller.debug.record(scope, state, { requestId: details.requestId, kind: details.kind, reason: details.reason ?? (state === 'group_push_failed' ? 'QQ_PUSH_FAILED' : undefined),
      count: details.count, attemptedCount: details.attemptedCount, httpStatus: details.httpStatus, bizCode: details.bizCode, traceId: details.traceId });
    if (state === 'group_push_failed') void controller.stopConversation(scope, 'SEND_FAILED')
      .catch(() => controller.debug.record(scope, 'task_stop_failed', { reason: 'STOP_FAILED' }));
    if (state === 'group_push_failed') void controller.notifyAdmins({ scope, requestId: details.requestId,
      reason: details.reason ?? 'QQ_PUSH_FAILED' });
  }, error => channel.diagnostics.errorDetails(error));
controller.groupPublisher = pushes;
try { await controller.start(); await channel.start(); } finally { await close(); }
