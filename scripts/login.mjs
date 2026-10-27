import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BilibiliLoginSession, pendingLoginPath } from '../lib/bilibili-login-session.mjs';
import { statePath } from '../lib/bilibili-auth.mjs';

process.umask(0o077);
const session = new BilibiliLoginSession();
try {
  if (process.argv.includes('--check')) {
    await session.restore();
    const status = await session.check();
    console.log(JSON.stringify({ status }));
    if (['authenticated', 'expired'].includes(status)) await rm(pendingLoginPath, { force: true });
    if (status !== 'authenticated') process.exitCode = 1;
  } else {
    const result = await session.open();
    if (result.status === 'authenticated') console.log('LOGIN_VERIFIED');
    else {
      await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
      const screenshot = join(dirname(statePath), 'bilibili-login.png');
      await writeFile(screenshot, result.image, { mode: 0o600 });
      await session.savePending();
      console.log(`QR_READY ${screenshot}; after scanning run node scripts/login.mjs --check`);
    }
  }
} catch {
  console.error('BILIBILI_LOGIN_FAILED'); process.exitCode = 1;
} finally { await session.close(); }
