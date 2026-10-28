import { mkdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Shared by the controller and MCP processes; only short video file operations hold this lock.
export async function withContentLock(store, task) {
  await mkdir(store.root, { recursive: true, mode: 0o700 });
  const path = join(store.root, 'video-records.lock');
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A crashed process may leave the directory behind. Normal operations finish well within five minutes.
      const info = await stat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info && Date.now() - info.mtimeMs > 300000) { await rm(path, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error('VIDEO_RECORDS_BUSY');
      await delay(50);
    }
  }
  try { return await task(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
