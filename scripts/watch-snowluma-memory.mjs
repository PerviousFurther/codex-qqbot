// Host-only operator service: no credentials, models, message reads or Docker socket in the application.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { MemoryPressure } from '../lib/snowluma-drain.mjs';
import { callSnowMaintenance } from '../lib/snowluma-maintenance.mjs';
const exec = promisify(execFile);
const container = 'llm-snowluma-trial-snowluma-1';
const socket = resolve('runtime/state/snowluma-maintenance.sock');
const pressure = new MemoryPressure();
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
const log = state => console.log(JSON.stringify({ state }));
const docker = async args => (await exec('docker', args, { timeout: 60000, maxBuffer: 4096 })).stdout.trim();
while (!stop.signal.aborted) {
  let token;
  try {
    const percent = Number((await docker(['stats', '--no-stream', '--format', '{{.MemPerc}}', container])).replace('%', ''));
    if (pressure.sample(percent, Date.now())) {
      pressure.attempted(Date.now());
      const begin = await callSnowMaintenance(socket, { action: 'begin' });
      token = begin.token;
      if (token) {
        log('memory_drain_started');
        const deadline = Date.now() + 600000;
        while (!stop.signal.aborted && Date.now() < deadline) {
          const status = await callSnowMaintenance(socket, { action: 'status', token });
          if (status.status === 'expired') break;
          if (status.status === 'idle') {
            const seal = await callSnowMaintenance(socket, { action: 'seal', token });
            if (seal.status === 'sealed' && !stop.signal.aborted) {
              await docker(['restart', '--time', '20', container]);
              log('memory_restart_completed');
              break;
            }
          }
          await delay(2000, undefined, { signal: stop.signal });
        }
      }
    }
  } catch { pressure.sample(NaN, Date.now()); if (!stop.signal.aborted) log('memory_watch_deferred'); }
  finally {
    if (token) await callSnowMaintenance(socket, { action: 'resume', token }).catch(() => log('memory_resume_pending_lease'));
  }
  await delay(30000, undefined, { signal: stop.signal }).catch(() => {});
}
