import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Store } from '../lib/store.mjs';

// Offline operator entry only: never exposed through model tools or a background timer.
process.umask(0o077);
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (['--all', '--offline'].includes(arg)) options[arg] = true;
  else if (['--data-dir', '--codex-home'].includes(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[arg] = process.argv[++i];
  else throw new Error('Usage: node scripts/clear-chat-records.mjs --all --offline [--data-dir PATH] [--codex-home PATH]');
}
if (!options['--all'] || !options['--offline']) throw new Error('STOP_BOT_FIRST_AND_PASS_ALL_OFFLINE');
const state = resolve(options['--data-dir'] ?? process.env.WATCH_DATA_DIR ?? '.state');
const codex = resolve(options['--codex-home'] ?? process.env.WATCH_CODEX_HOME ?? '.auth/codex');
if ([state, codex].some(path => path === dirname(path) || path === homedir()) || codex === resolve(homedir(), '.codex')
  || state === codex || state.startsWith(codex + '/') || codex.startsWith(state + '/')) throw new Error('ISOLATED_SERVICE_DIRECTORIES_REQUIRED');
for (const entry of await readdir('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  const args = await readFile(`/proc/${entry}/cmdline`).catch(() => Buffer.alloc(0));
  if (args.toString().split('\0').some(arg => arg === 'scripts/start.mjs' || arg.endsWith('/scripts/start.mjs'))) throw new Error('BOT_STILL_RUNNING');
}
async function existingDirectory(path) {
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('CLEANUP_DIRECTORY_INVALID');
  return true;
}
async function removeChild(root, name) {
  const path = join(root, name);
  const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!info) return false;
  await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
  return true;
}
let checkpoints = 0, stateAreas = 0, codexAreas = 0;
const hasState = await existingDirectory(state), hasCodex = await existingDirectory(codex);
if (hasState) {
  const store = new Store(state);
  const directory = join(state, 'conversations');
  if (await existingDirectory(directory)) for (const name of await readdir(directory)) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    const path = join(directory, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('CHECKPOINT_FILE_INVALID');
    const previous = await store.read(path, null);
    // Keep explicit model/effort preferences only; no thread, seen IDs or old fields.
    await store.write(path, { model: previous?.model ?? null, reasoningEffort: previous?.reasoningEffort ?? null, threadId: null, seen: [] });
    checkpoints++;
  }
  for (const name of ['group-context', 'message-records', 'message-images', 'saved-images', 'workspace', 'reply-contacts.json', 'activity', 'runtime', 'diagnostics.json',
    'qq-pair.log', 'qq-probe.json', 'qq-pair-challenge.json', 'qq-pair-session.json', 'qq-pair-status.json', 'probe']) {
    if (await removeChild(state, name)) stateAreas++;
  }
}
if (hasCodex) for (const name of await readdir(codex)) {
  if (['sessions', 'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'shell_snapshots', 'thread-writer-locks', 'log'].includes(name)
    || /^(?:state|memories|logs|queue|goals)_\d+\.sqlite(?:-(?:wal|shm))?$/.test(name)) {
    if (await removeChild(codex, name)) codexAreas++;
  }
}
console.log(JSON.stringify({ state: 'CHAT_RECORDS_CLEARED', checkpoints, stateAreas, codexAreas,
  preserved: 'credentials, authorization, settings, model choices, persona, role state, video facts' }));
