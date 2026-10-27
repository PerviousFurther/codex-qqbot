import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

export const statePath = resolve(process.env.WATCH_BILIBILI_STATE ?? '.auth/bilibili.json');

// Only an explicit account response proves logout; an API/network error does not.
export async function bilibiliLoginState(context) {
  const response = await context.request.get('https://api.bilibili.com/x/web-interface/nav', { timeout: 15_000 });
  if (!response.ok()) return null;
  const payload = await response.json();
  if (payload.code === -101) return false;
  return payload.code === 0 && typeof payload.data?.isLogin === 'boolean' ? payload.data.isLogin : null;
}

export async function createBilibiliContext(browser, options = {}) {
  let savedSessionLoaded = false;
  try {
    await access(statePath);
    savedSessionLoaded = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const context = await browser.newContext({
    ...options, ...(savedSessionLoaded ? { storageState: statePath } : {}),
  });
  let authenticated = false;
  try {
    if (savedSessionLoaded) authenticated = await bilibiliLoginState(context);
  } catch (error) { await context.close(); throw error; }
  return { context, authenticated, savedSessionLoaded };
}
