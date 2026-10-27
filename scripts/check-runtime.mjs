import { chromium } from 'playwright';
import { createBilibiliContext } from '../lib/bilibili-auth.mjs';
import { CodexAdapter } from '../lib/codex-adapter.mjs';

// Deployment checks do not request a model reply or send QQ messages.
const adapter = new CodexAdapter({
  dataDir: process.env.WATCH_DATA_DIR,
  codexHome: process.env.WATCH_CODEX_HOME,
});
let browser;
try {
  await adapter.prepare({ scope: 'deployment-check' });
  console.log('Codex read-only session and video MCP initialized.');
  browser = await chromium.launch({ headless: true });
  const { context, authenticated } = await createBilibiliContext(browser);
  await context.close();
  if (!authenticated) throw new Error('BILIBILI_LOGIN_EXPIRED');
  console.log('Chromium launched; saved Bilibili login verified.');
} catch (error) {
  const code = error.message === 'BILIBILI_LOGIN_EXPIRED'
    ? 'BILIBILI_LOGIN_EXPIRED' : 'RUNTIME_CHECK_FAILED';
  console.error(code);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await adapter.close();
}
