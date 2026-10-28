// Offline: fake RPC sessions and a local stderr fixture; no Codex/model/QQ calls.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { CodexAdapter } from '../lib/codex-adapter.mjs';
import { RpcProcess } from '../lib/codex-rpc.mjs';
import { agentStderrFailure } from '../lib/agent-diagnostics.mjs';

function fixture(options = {}) {
  const adapter = new CodexAdapter(options); const rpc = new EventEmitter();
  rpc.close = () => { rpc.closed = true; };
  let submitted;
  const started = new Promise(resolve => { submitted = resolve; });
  rpc.request = async method => { if (method === 'turn/start') submitted(); return { turn: { id: 'turn' } }; };
  const session = { rpc, threadId: 'thread', turns: 0,
    bridge: { bind: () => ({ turn: {}, close: async () => {} }) } };
  adapter.prepare = async () => session; adapter.modelsFor = async () => [];
  const notify = (method, params) => rpc.emit('notification', { method, params: { threadId: 'thread', ...params } });
  const complete = () => {
    notify('item/completed', { item: { type: 'agentMessage', text: JSON.stringify({ pauseBrowsing: false, sharedState: null }) } });
    notify('turn/completed', { turn: { status: 'completed' } });
  };
  return { adapter, rpc, started, notify, complete };
}

const f = fixture(); assert.equal(f.adapter.turnTimeoutMs, 0);
const updates = []; const toolUpdates = [];
const running = f.adapter.run({ scope: 'c2c:fixture', text: 'fixture', onUpdate: event => toolUpdates.push(event),
  onDiagnostic: (stage, details) => updates.push({ stage, ...details }) });
await assert.rejects(f.adapter.run({ scope: 'c2c:fixture', text: 'second' }), /CONVERSATION_BUSY/);
await f.started;
const opened = { type: 'webSearch', id: 'web', action: { type: 'openPage', url: 'https://github.com/v2fly?SECRET=1#PRIVATE' } };
f.notify('item/started', { item: opened });
f.notify('item/completed', { item: opened });
assert.equal(toolUpdates.at(-1).name, 'web_open_page');
assert.deepEqual(toolUpdates.at(-1).urls, ['https://github.com/v2fly']);
f.notify('item/started', { item: { type: 'webSearch', id: 'search', action: { type: 'search', query: 'SECRET_QUERY' } } });
f.notify('item/completed', { item: { type: 'webSearch', id: 'search', results: [{ url: 'https://www.reddit.com/r/test?q=SECRET' }] } });
assert.deepEqual(toolUpdates.at(-1).urls, ['https://www.reddit.com/r/test']);
const mcp = { type: 'mcpToolCall', server: 'video', id: 'read', tool: 'read_webpage',
  arguments: { url: 'https://github.com/v2fly?q=SECRET', ignored: 'SECRET_BODY' } };
f.notify('item/started', { item: mcp });
f.notify('item/completed', { item: { ...mcp, result: { content: [] } } });
assert.deepEqual(toolUpdates.at(-1).urls, ['https://github.com/v2fly']);
const openedMcp = { ...mcp, id: 'public-open', tool: 'open_webpage' };
f.notify('item/started', { item: openedMcp });
f.notify('item/completed', { item: { ...openedMcp, result: { content: [] } } });
assert.equal(toolUpdates.at(-1).name, 'open_webpage');
assert.deepEqual(toolUpdates.at(-1).urls, ['https://github.com/v2fly']);
assert(!JSON.stringify(toolUpdates).includes('SECRET'));
const contextMcp = { type: 'mcpToolCall', server: 'video', id: 'context-read', tool: 'read_chat_context',
  arguments: { query: 'SECRET_QUERY', target: 'SECRET_ALIAS' } };
f.notify('item/started', { item: contextMcp });
f.notify('item/completed', { item: { ...contextMcp, result: { content: [] } } });
assert.equal(toolUpdates.at(-1).name, 'read_chat_context');
for (const tool of ['list_files', 'read_file', 'save_file', 'delete_file']) {
  const note = { type: 'mcpToolCall', server: 'video', id: `note-${tool}`, tool,
    arguments: { area: 'memory', name: 'SECRET_NAME.md', text: 'SECRET_BODY' } };
  f.notify('item/started', { item: note });
  assert.equal(toolUpdates.at(-1).memoryNote, true);
  // Completion may omit arguments; retain only the fixed classification.
  f.notify('item/completed', { item: { ...note, arguments: undefined, result: { content: [] } } });
  assert.equal(toolUpdates.at(-1).memoryNote, true);
  f.notify('item/started', { item: { ...note, id: `file-${tool}`, arguments: { area: 'workspace' } } });
  assert.equal(toolUpdates.at(-1).memoryNote, undefined);
  f.notify('item/completed', { item: { ...note, id: `file-${tool}`, arguments: undefined } });
  assert.equal(toolUpdates.at(-1).memoryNote, undefined);
}
assert(!JSON.stringify(toolUpdates).includes('SECRET'));
assert(!JSON.stringify(updates).includes('https://'));
f.notify('error', { willRetry: true, error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } }, message: 'SECRET_BODY' } });
assert.equal(updates.at(-1).stage, 'model_error'); assert.equal(updates.at(-1).agentCode, 'httpConnectionFailed');
assert.equal(updates.at(-1).httpStatus, 503); assert.equal(updates.at(-1).kind, 'retrying');
assert(!JSON.stringify(updates).includes('SECRET_BODY'));
for (const [name, kind, extension] of [['SECRET_NAME.PNG', 'image'], ['SECRET_NAME.gif', 'gif'],
  ['SECRET_NAME.mp4', 'video'], ['SECRET_NAME.mp3', 'audio'], ['SECRET_NAME.txt', 'text'],
  ['SECRET_NAME.xyz', 'binary', 'xyz'], ['SECRET_NAME', 'no_extension']]) {
  const item = { type: 'mcpToolCall', server: 'video', id: `suffix-${kind}`, tool: 'save_file', arguments: { name, text: 'SECRET_BODY' } };
  f.notify('item/started', { item });
  assert.equal(toolUpdates.at(-1).fileKind, kind);
  f.notify('item/completed', { item: { ...item, arguments: undefined } });
  assert.equal(toolUpdates.at(-1).fileKind, kind);
  assert.equal(toolUpdates.at(-1).fileExtension, extension);
}
assert(!JSON.stringify(toolUpdates).includes('SECRET'));
assert(!JSON.stringify(updates).includes('fileExtension'));
const beforeFinal = toolUpdates.length;
f.notify('item/started', { item: { type: 'agentMessage', phase: 'final_answer' } });
f.complete(); await running;
assert.equal(toolUpdates.length, beforeFinal); // Structured final output is not a recipient reply.
assert.equal(f.rpc.listenerCount('diagnostic'), 0); assert.equal(f.adapter.runningScopes.size, 0);
const again = f.adapter.run({ scope: 'c2c:fixture', text: 'next' });
await new Promise(resolve => setImmediate(resolve)); f.complete(); await again;

const terminal = fixture(); const failed = terminal.adapter.run({ scope: 'c2c:terminal', text: 'fixture' });
await terminal.started;
terminal.notify('error', { willRetry: false, error: { codexErrorInfo: 'unauthorized', message: 'SECRET_TOKEN' } });
await assert.rejects(failed, error => error.agentCode === 'unauthorized' && !error.message.includes('SECRET'));
assert.equal(terminal.rpc.closed, true);
const timed = fixture({ turnTimeoutMs: 20 });
await assert.rejects(timed.adapter.run({ scope: 'c2c:timed', text: 'fixture' }), /CODEX_TURN_TIMEOUT/);
assert.equal(timed.rpc.closed, true);
const cancelled = fixture(); const aborter = new AbortController();
const cancelledRun = cancelled.adapter.run({ scope: 'c2c:cancelled', text: 'fixture', signal: aborter.signal });
await cancelled.started; aborter.abort();
await assert.rejects(cancelledRun, /TURN_CANCELLED/);
assert.equal(cancelled.adapter.runningScopes.size, 0);
assert.equal(cancelled.rpc.listenerCount('diagnostic'), 0);

const independent = new CodexAdapter(); const scopes = [];
independent.runTurn = async ({ scope }) => { scopes.push(scope); await new Promise(resolve => setImmediate(resolve)); };
await Promise.all(['c2c:first', 'group:second'].map(scope => independent.run({ scope })));
assert.equal(scopes.length, 2); assert.equal(independent.runningScopes.size, 0);

assert.equal(agentStderrFailure('ordinary model commentary'), null);
assert.equal(agentStderrFailure('workspace routing discovery failed: PRIVATE_URL').agentCode, 'httpConnectionFailed');
const rpc = new RpcProcess({ command: process.execPath, args: ['-e',
  'process.stderr.write("error sending request for url PRIVATE_SECRET\\n");setInterval(()=>{},1000)'], env: {}, cwd: '/tmp' });
try {
  const [error] = await once(rpc, 'diagnostic');
  assert.equal(error.agentCode, 'httpConnectionFailed'); assert.equal(error.message, 'CODEX_UPSTREAM_ERROR');
  assert(!JSON.stringify(error).includes('PRIVATE_SECRET'));
} finally { await rpc.close(); }
console.log('Offline Codex lifecycle checks passed: same-scope exclusion, retry/terminal error metadata, optional deadline and bounded stderr classification.');
