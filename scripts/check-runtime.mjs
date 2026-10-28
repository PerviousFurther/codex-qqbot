import { chromium } from 'playwright';
import { CodexAdapter } from '../lib/codex-adapter.mjs';

// Deployment checks do not request a model reply or send QQ messages.
const adapter = new CodexAdapter({
  dataDir: process.env.WATCH_DATA_DIR,
  codexHome: process.env.WATCH_CODEX_HOME,
});
let browser;
try {
  await adapter.prepare({ scope: 'deployment-check' });
  console.log('Codex read-only session and project MCP initialized.');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.close();
  console.log('Chromium launched; isolated context closed. Website authentication is not probed.');
} catch (error) {
  const code = 'RUNTIME_CHECK_FAILED';
  console.error(code);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await adapter.close();
}
