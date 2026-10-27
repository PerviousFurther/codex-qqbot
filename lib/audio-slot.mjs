import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// MCP runs per conversation. Keep at most one local model job across those
// processes; never reclaim a slot from a live owner or hold a SQL transaction
// during download/inference. A dead owner's slot can be reclaimed after a crash.
export async function acquireAudioSlot(store) {
  await mkdir(store.root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(store.root, 'audio-slot.sqlite'), { timeout: 2500, allowExtension: false });
  const token = randomUUID();
  let owned = false;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS slot(id INTEGER PRIMARY KEY CHECK(id=1),owner INTEGER NOT NULL,token TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT owner FROM slot WHERE id=1').get();
      if (previous) {
        let alive = true;
        try { process.kill(previous.owner, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('AUDIO_DECODER_BUSY');
      }
      db.prepare('INSERT OR REPLACE INTO slot(id,owner,token) VALUES(1,?,?)').run(process.pid, token);
      db.exec('COMMIT'); owned = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { db.prepare('DELETE FROM slot WHERE id=1 AND token=?').run(token); }
      finally { db.close(); }
    };
  } finally {
    if (!owned) db.close();
  }
}

export async function withAudioSlot(store, task) {
  const release = await acquireAudioSlot(store);
  try { return await task(); } finally { release(); }
}
