import { join } from 'node:path';
import { serveSnowMaintenance } from '../lib/snowluma-maintenance.mjs';
import { configureWebAccess } from '../lib/web-access-policy.mjs';
import { Store } from '../lib/store.mjs';
import { CodexAdapter } from '../lib/codex-adapter.mjs';
import { VideoController } from '../lib/controller.mjs';
import { SnowLumaChannel } from '../lib/snowluma-channel.mjs';
import { qqId, snowIdentity } from '../lib/snowluma-identity.mjs';
import { snowEndpoint } from '../lib/snowluma-transport.mjs';

process.umask(0o077);
let controller, channel, closing, closeMaintenance;
async function close() {
  if (closing) return closing;
  const channelStop = channel?.stop();
  closing = (async () => { await closeMaintenance?.(); await controller?.close(); await channelStop; })();
  return closing;
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
  // Explicit operator binding is mandatory. Retained admin.json/OpenIDs and
  // first-message claims cannot authorize this ordinary-account transport.
  const account = qqId(process.env.SNOWLUMA_ACCOUNT_ID);
  const admins = [...new Set((process.env.SNOWLUMA_ADMIN_QQS ?? '').split(',').map(x => x.trim()).filter(Boolean))]
    .map(value => snowIdentity(account, value));
  if (!admins.length || admins.includes(snowIdentity(account, account))) throw new Error('SNOWLUMA_ADMIN_BINDING_REQUIRED');
  const wsUrl = snowEndpoint(process.env.SNOWLUMA_WS_URL ?? 'ws://snowluma:3001/', 'ws:');
  const httpUrl = snowEndpoint(process.env.SNOWLUMA_HTTP_URL ?? 'http://snowluma:3000/', 'http:');
  if (!process.env.SNOWLUMA_WS_TOKEN?.trim() || !process.env.SNOWLUMA_HTTP_TOKEN?.trim()) throw new Error('SNOWLUMA_TOKEN_REQUIRED');
  process.env.WATCH_ADMIN_IDS = admins.join(',');
  const dataDir = process.env.WATCH_DATA_DIR ?? '.state';
  const store = new Store(dataDir); configureWebAccess(store.root);
  const adapter = new CodexAdapter({ dataDir, codexHome: process.env.WATCH_CODEX_HOME ?? '.auth/codex' });
  controller = new VideoController({ adapter, store, admins });
  controller.on('state', event => console.error(JSON.stringify(event)));
  channel = new SnowLumaChannel({ account, wsUrl, wsToken: process.env.SNOWLUMA_WS_TOKEN, httpUrl,
    httpToken: process.env.SNOWLUMA_HTTP_TOKEN, controller,
    onState: (state, details = {}) => console.error(JSON.stringify({ channel: 'snowluma', state, ...details })) });
  await channel.start();
  if (!closing) { await controller.start(); await channel.activate();
    closeMaintenance = await serveSnowMaintenance(join(store.root, 'snowluma-maintenance.sock'), channel.drain);
  }
} catch (error) {
  const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? '') ? error.message : 'SNOWLUMA_START_FAILED';
  console.error(JSON.stringify({ state: 'startup_failed', reason }));
  await close(); process.exitCode = 1;
}
