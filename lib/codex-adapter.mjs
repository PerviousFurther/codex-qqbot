import { webFeedbackUrls } from './web-feedback.mjs';
import { fileFeedback } from './file-feedback.mjs';
import { agentInput } from './agent-input.mjs';
import { RpcProcess } from './codex-rpc.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_INSTRUCTIONS, conversationInstructions } from './agent-instructions.mjs';
import { scopeId } from './policy.mjs';
import { agentFailure } from './agent-diagnostics.mjs';
import { toolApprovals } from './tool-policy.mjs';
import { ReplyBridge } from './reply-bridge.mjs';
import { randomUUID } from 'node:crypto';
import { sharedStateSchema, validSharedState } from './shared-state.mjs';

const mcpEntry = fileURLToPath(new URL('../scripts/mcp.mjs', import.meta.url));
const CODEX_RUNTIME = {
  'features.shell_tool': false, 'features.unified_exec': false,
  // exec is also the MCP tool dispatcher; disabling its host hides working tools.
  'features.code_mode': false, 'features.code_mode_host': true,
  'features.multi_agent': false, 'features.apps': false, 'features.plugins': false,
  'features.hooks': false, 'features.browser_use': false, 'features.computer_use': false,
  'tools.view_image': false, web_search: 'live', project_doc_max_bytes: 0,
};
const outputSchema = {
  type: 'object', additionalProperties: false,
  properties: { pauseBrowsing: { type: 'boolean' },
    sharedState: { anyOf: [sharedStateSchema, { type: 'null' }] } },
  required: ['pauseBrowsing', 'sharedState'],
};

export class CodexAdapter {
  constructor({ dataDir = '.state', codexHome = '.auth/codex', maxSessions = 2, turnTimeoutMs = 0,
    command = 'codex' } = {}) {
    this.dataDir = resolve(dataDir); this.codexHome = resolve(codexHome);
    this.maxSessions = maxSessions; this.turnTimeoutMs = turnTimeoutMs;
    this.command = command; this.sessions = new Map(); this.pins = new Map(); this.sessionTail = Promise.resolve();
    this.runningScopes = new Set();
  }
  async lease(scope, operation) {
    this.pins.set(scope, (this.pins.get(scope) ?? 0) + 1);
    try { return await operation(); }
    finally { this.pins.set(scope, this.pins.get(scope) - 1); }
  }
  session(scope) {
    const result = this.sessionTail.then(() => this.openSession(scope));
    this.sessionTail = result.catch(() => {}); return result;
  }
  async openSession(scope) {
    const existing = this.sessions.get(scope);
    if (existing && !existing.rpc.closed) { existing.lastUsed = Date.now(); await existing.ready; return existing; }
    if (existing) { await existing.bridge?.close(); this.sessions.delete(scope); }
    if (this.sessions.size >= this.maxSessions) {
      const idle = [...this.sessions.entries()].filter(([key, value]) => !this.pins.get(key) && !value.turn)
        .sort((a, b) => (a[1].lastUsed ?? 0) - (b[1].lastUsed ?? 0))[0];
      if (!idle) throw new Error('SESSION_LIMIT_REACHED');
      await this.reset(idle[0]);
    }
    const cwd = resolve(this.dataDir, 'runtime', scopeId(scope));
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    const env = {};
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.CODEX_HOME = this.codexHome;
    const args = Object.entries(CODEX_RUNTIME).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
    args.push('app-server', '--listen', 'stdio://');
    const rpc = new RpcProcess({ command: this.command, args, env, cwd });
    const session = { rpc, cwd, turn: null, threadId: null, model: null, turns: 0, lastUsed: Date.now() };
    this.sessions.set(scope, session);
    session.ready = rpc.request('initialize', { clientInfo: { name: 'watch-video', version: '0.1.0' } })
      .then(() => rpc.send({ method: 'initialized' }));
    // Settle the shared readiness promise even if the process exits early.
    session.ready.catch(() => {});
    await session.ready;
    return session;
  }
  models(scope, options = {}) { return this.lease(scope, () => this.readModels(scope, options)); }
  async readModels(scope, { refresh = false } = {}) {
    const session = await this.session(scope);
    return this.modelsFor(session, { refresh });
  }
  async modelsFor(session, { refresh = false } = {}) {
    if (!refresh && session.modelsCache?.expiresAt > Date.now()) return session.modelsCache.items;
    session.modelsRequest ??= this.fetchModels(session).then(items => {
      session.modelsCache = { items, expiresAt: Date.now() + 60000 };
      return items;
    }).finally(() => { session.modelsRequest = null; });
    return session.modelsRequest;
  }
  async fetchModels(session) {
    const models = [];
    let cursor = null;
    do {
      const page = await session.rpc.request('model/list', { cursor, limit: 100 });
      models.push(...page.data.map(model => ({ id: model.model, name: model.displayName,
        description: model.description, isDefault: model.isDefault,
        defaultEffort: model.defaultReasoningEffort,
        efforts: (model.supportedReasoningEfforts ?? []).map(item => ({ id: item.reasoningEffort, description: item.description })) })));
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }
  async prepare({ scope, checkpoint = {}, onCheckpoint = async () => {}, allowProjectFiles = false,
    allowReplies = false, persona = {}, replyMode = 'none' }) {
    allowProjectFiles = allowProjectFiles === true && scope.startsWith('c2c:');
    const instructions = conversationInstructions(scope, persona, allowReplies ? replyMode : 'none');
    let session = await this.session(scope);
    if (session.turn) throw new Error('CONVERSATION_BUSY');
    if (session.threadId && (session.allowProjectFiles !== allowProjectFiles
      || session.allowReplies !== allowReplies || session.developerInstructions !== instructions)) {
      await this.reset(scope);
      session = await this.session(scope);
    }
    if (!session.threadId) {
      if (!session.bridge) {
        session.bridge = await ReplyBridge.open();
        session.rpc.once('closed', () => { session.bridge.close().catch(() => {}); });
      }
      const config = {
        ...CODEX_RUNTIME,
        mcp_servers: { video: { ...toolApprovals(scope.startsWith('group:'), allowReplies), command: process.execPath, args: [mcpEntry], required: true,
          env: { WATCH_SCOPE: scope, WATCH_DATA_DIR: this.dataDir,
            WATCH_ADMIN_IDS: process.env.WATCH_ADMIN_IDS ?? process.env.WATCH_ADMIN_OPENIDS ?? '',
            ...Object.fromEntries(['WATCH_AUDIO_MODEL_DIR', 'WATCH_AUDIO_VAD_MODEL', 'WATCH_AUDIO_RUNTIME_DIR', 'WATCH_AUDIO_THREADS']
              .filter(name => process.env[name]).map(name => [name, process.env[name]])),
            WATCH_PROJECT_FILES: String(allowProjectFiles), WATCH_PROJECT_ROOT: '/workspace/project',
            WATCH_EVENT_SOCKET: session.bridge.path,
            ...(allowReplies && session.bridge ? { WATCH_REPLY_SOCKET: session.bridge.path } : {}),
            ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) },
          startup_timeout_sec: 30, tool_timeout_sec: 120 } },
      };
      const params = { cwd: session.cwd, sandbox: 'read-only', approvalPolicy: 'never',
        baseInstructions: BOT_INSTRUCTIONS, developerInstructions: instructions, config,
        ...(checkpoint.model ? { model: checkpoint.model } : {}) };
      const result = checkpoint.threadId
        ? await session.rpc.request('thread/resume', { ...params, threadId: checkpoint.threadId, excludeTurns: true })
        : await session.rpc.request('thread/start', params);
      if (result.sandbox?.type !== 'readOnly' || result.approvalPolicy !== 'never') {
        session.rpc.close(); this.sessions.delete(scope);
        throw new Error('RESTRICTED_RUNTIME_REQUIRED');
      }
      session.threadId = result.thread.id; session.model = checkpoint.model ?? result.model;
      session.allowProjectFiles = allowProjectFiles;
      session.allowReplies = allowReplies; session.developerInstructions = instructions;
      await onCheckpoint({ threadId: session.threadId, model: session.model });
    }
    return session;
  }
  async run(options) {
    // Reserve before session preparation/model discovery can yield to another caller.
    if (this.runningScopes.has(options.scope)) throw new Error('CONVERSATION_BUSY');
    this.runningScopes.add(options.scope);
    try { return await this.lease(options.scope, () => this.runTurn(options)); }
    finally { this.runningScopes.delete(options.scope); }
  }
  async runTurn({ scope, text, memory = [], checkpoint = {}, signal, onCheckpoint = async () => {}, allowProjectFiles = false,
    onUpdate = () => {}, preferences = {}, groupContext = null, sharedState = null, persona = {}, currentSpeaker = null, messageContent = null, messageImages = [], onDiagnostic = () => {},
    onReply, onEvents, onGuard, onMediaEvent, onWebDomainRequest, onChatContext, onTurnEnd = () => {}, onInputAccepted = async () => {}, interruptedWork = [], replyTargets = [], replyMode = 'foreground' }) {
    if (signal?.aborted) throw new Error('TURN_CANCELLED');
    const session = await this.prepare({ scope, checkpoint, onCheckpoint, allowProjectFiles, persona, allowReplies: typeof onReply === 'function', replyMode });
    if (signal?.aborted) throw new Error('TURN_CANCELLED');
    const catalogue = await this.modelsFor(session);
    const model = catalogue.find(item => item.id === (checkpoint.model ?? session.model));
    if (checkpoint.reasoningEffort && !model?.efforts.some(item => item.id === checkpoint.reasoningEffort)) {
      throw new Error('REASONING_EFFORT_UNAVAILABLE');
    }
    const effort = checkpoint.reasoningEffort ?? model?.defaultEffort;
    onDiagnostic('persona_applied', { kind: persona.id ?? 'natural', chars: persona.description?.length ?? 0 });
    if (signal?.aborted) throw new Error('TURN_CANCELLED');
    const binding = session.bridge.bind({ id: randomUUID(), send: onReply, events: onEvents, guard: onGuard, mediaEvent: onMediaEvent, webDomainRequest: onWebDomainRequest, chatContext: onChatContext,
      onSkip: details => onDiagnostic('reply_part_skipped', details) });
    const replySession = onReply ? { turn_id: binding.turn.id, targets: replyTargets, mode: replyMode } : null;
    const eventSession = { turn_id: binding.turn.id };
    const input = agentInput({ text, memory, currentSpeaker, messageContent, messageImages, preferences, groupContext, sharedState, replySession, eventSession, interruptedWork });
    return new Promise((accept, reject) => {
      const turn = { id: null, answer: '', settled: false, error: null, outputObserved: false };
      session.turn = turn;
      const toolStarts = new Map();
      const startTool = (key, name, urls = [], fileDetails = {}) => {
        if (toolStarts.has(key)) return;
        toolStarts.set(key, { name, startedAt: Date.now(), urls, fileDetails });
        onUpdate({ kind: 'tool', name, urls, ...fileDetails });
      };
      const finishTool = (key, name, status, urls = [], fileDetails = {}) => {
        const started = toolStarts.get(key); toolStarts.delete(key);
        const elapsedMs = started ? Math.max(0, Date.now() - started.startedAt) : undefined;
        onUpdate({ kind: 'tool-result', name: started?.name ?? name, status,
          ...(started?.fileDetails ?? fileDetails),
          urls: webFeedbackUrls([...urls, ...(started?.urls ?? [])]), ...(elapsedMs !== undefined ? { elapsedMs } : {}) });
        return elapsedMs;
      };
      turn.ready = new Promise(resolve => { turn.resolveReady = resolve; });
      const finish = (error, value) => {
        if (turn.settled) return;
        turn.settled = true; clearTimeout(timer);
        for (const [key, tool] of toolStarts) finishTool(key, tool.name, 'interrupted');
        turn.resolveReady();
        const cleanup = binding?.close();
        signal?.removeEventListener('abort', abort);
        session.rpc.off('notification', notify); session.rpc.off('closed', closed); session.rpc.off('diagnostic', diagnostic);
        Promise.all([Promise.resolve(turn.inputCommit).catch(() => {}), cleanup, Promise.resolve().then(onTurnEnd)]).catch(cleanupError => { error ??= cleanupError; session.rpc.close(); }).then(() => {
          session.turn = null;
          if (error || turn.commitError) reject(error ?? turn.commitError); else {
            session.turns++;
            accept({ ...value, replyAttempted: binding?.turn.attemptedCount ?? 0, replyAnswerSent: binding?.turn.answerSent ?? 0, replyRoutedSent: binding?.turn.routedSent ?? 0, replyDeliveryFailed: binding?.turn.failed ?? false, replyCurrentRejected: binding?.turn.currentRejected ?? false });
          }
        });
      };
      const abort = () => {
        if (turn.id) session.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: turn.id }).catch(() => {});
        // The controller serializes work, but do not reuse this process while cancellation
        // may still be running. Resuming the persisted thread uses a fresh process.
        finish(new Error('TURN_CANCELLED'));
        session.rpc.close();
      };
      const closed = () => finish(turn.failure ?? new Error('CODEX_PROCESS_EXITED'));
      const diagnostic = error => {
        turn.failure = error;
        onDiagnostic('model_error', { reason: error.message, agentCode: error.agentCode,
          httpStatus: error.upstreamStatus, kind: 'retrying' });
      };
      const notify = ({ method, params }) => {
        if (params?.threadId !== session.threadId) return;
        if (method === 'error') {
          turn.error = params.error;
          const error = agentFailure(params.error);
          turn.failure = error;
          onDiagnostic('model_error', { reason: error.message, agentCode: error.agentCode,
            httpStatus: error.upstreamStatus, kind: params.willRetry === true ? 'retrying' : 'terminal' });
          if (params.willRetry === false) { finish(error); session.rpc.close(); return; }
        }
        if (['item/started', 'item/completed'].includes(method) && params.item?.type === 'webSearch') {
          const action = params.item.action?.type;
          const tool = action === 'openPage' ? 'web_open_page' : action === 'findInPage' ? 'web_find_page' : 'web_search';
          const started = method === 'item/started';
          const key = `web:${params.item.id ?? tool}`;
          const urls = webFeedbackUrls([params.item.action?.url,
            ...(!started && Array.isArray(params.item.results) ? params.item.results.slice(0, 40).map(result => result?.url) : [])]);
          if (started) startTool(key, tool, urls);
          const elapsedMs = started ? undefined : finishTool(key, tool, params.item.error || params.item.status === 'failed' ? 'failed' : 'completed', urls);
          onDiagnostic(started ? 'web_search_started' : 'web_search_completed', { tool, ...(elapsedMs !== undefined ? { elapsedMs } : {}),
            ...(Array.isArray(params.item.results) && !started ? { count: params.item.results.length } : {}) });
        }
        if (method === 'item/started' && params.item?.type === 'mcpToolCall'
          && params.item.server === 'video') {
          onDiagnostic('mcp_started', { tool: params.item.tool });
          const urls = ['read_webpage', 'open_webpage'].includes(params.item.tool)
            ? webFeedbackUrls([params.item.arguments?.url]) : [];
          startTool(`mcp:${params.item.id ?? params.item.tool}`, params.item.tool, urls, fileFeedback(params.item));
        }
        if (method === 'item/completed' && params.item?.type === 'mcpToolCall' && params.item.server === 'video') {
          let reason;
          for (const block of params.item.result?.content ?? []) {
            if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 20000) continue;
            try {
              const value = JSON.parse(block.text);
              if (value.ok === false && /^[A-Z][A-Z0-9_]{2,79}$/.test(value.code ?? '')) reason = value.code;
            } catch {}
          }
          const failed = reason || params.item.error || params.item.result?.isError || params.item.status === 'failed';
          const elapsedMs = finishTool(`mcp:${params.item.id ?? params.item.tool}`, params.item.tool, failed ? 'failed' : 'completed', [], fileFeedback(params.item));
          onDiagnostic(failed ? 'mcp_failed' : 'mcp_completed', { tool: params.item.tool, ...(elapsedMs !== undefined ? { elapsedMs } : {}), ...(reason ? { reason } : {}) });
        }
        if (!turn.outputObserved && ((method === 'item/agentMessage/delta' && params.delta)
          || method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text)) {
          turn.outputObserved = true; onDiagnostic('model_output', {});
        }
        // Deliberately ignore reasoning items and reasoning deltas.
        if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') turn.answer = params.item.text;
        if (method === 'turn/completed') {
          if (params.turn.status !== 'completed') return finish(params.turn.error || turn.error
            ? agentFailure(params.turn.error ?? turn.error) : turn.failure ?? agentFailure());
          try {
            const value = JSON.parse(turn.answer);
            if (typeof value.pauseBrowsing !== 'boolean'
              || value.sharedState !== null && !validSharedState(value.sharedState)) throw new Error();
            onDiagnostic('model_final', { outputChars: turn.answer.length });
            finish(null, value);
          } catch { finish(new Error('INVALID_AGENT_OUTPUT')); }
        }
      };
      const timer = this.turnTimeoutMs > 0 ? setTimeout(() => {
        finish(turn.failure ?? new Error('CODEX_TURN_TIMEOUT'));
        session.rpc.close();
      }, this.turnTimeoutMs) : null;
      session.rpc.on('notification', notify); session.rpc.once('closed', closed); session.rpc.on('diagnostic', diagnostic);
      signal?.addEventListener('abort', abort, { once: true });
      onDiagnostic('model_submitted', { inputChars: input.length });
      turn.inputCommit = session.rpc.request('turn/start', { threadId: session.threadId, input: [{ type: 'text', text: input }],
        ...(effort ? { effort } : {}),
        ...(checkpoint.model ? { model: checkpoint.model } : {}), outputSchema,
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }).then(async result => {
        turn.id = result.turn.id;
        await onInputAccepted();
        turn.resolveReady(); onDiagnostic('model_accepted', {});
      }).catch(error => { turn.commitError = error; finish(error); session.rpc.close(); });
    });
  }
  async steer(scope, status) {
    const session = this.sessions.get(scope); const turn = session?.turn;
    if (!turn) return false;
    await turn.ready;
    if (turn.settled || session.turn !== turn || !turn.id) return false;
    await session.rpc.request('turn/steer', { threadId: session.threadId, expectedTurnId: turn.id,
      input: [{ type: 'text', text: `Current-conversation event notice: ${JSON.stringify(status)}\nCall check_pending_events before deciding how to proceed. For media notices, consult read_media using the original media_id, track and selection. New input does not require a reply; follow the latest intent and existing turn rules.` }] });
    return true;
  }
  compact(scope) { return this.lease(scope, () => this.compactThread(scope)); }
  async compactThread(scope) {
    const session = this.sessions.get(scope);
    if (session?.turn) throw new Error('CONVERSATION_BUSY');
    if (!session?.threadId) return false;
    await new Promise((accept, reject) => {
      const finish = error => {
        clearTimeout(timer); session.rpc.off('notification', notify); session.rpc.off('closed', closed);
        if (error) reject(error); else accept();
      };
      const notify = ({ method, params }) => {
        if (params?.threadId === session.threadId && method === 'item/completed' && params.item?.type === 'contextCompaction') finish();
      };
      const closed = () => finish(new Error('CODEX_PROCESS_EXITED'));
      const timer = setTimeout(() => finish(new Error('COMPACTION_TIMEOUT')), 120000);
      session.rpc.on('notification', notify); session.rpc.once('closed', closed);
      session.rpc.request('thread/compact/start', { threadId: session.threadId }).catch(finish);
    });
    return true;
  }
  async reset(scope) {
    const session = this.sessions.get(scope);
    this.sessions.delete(scope);
    await session?.rpc.close();
    await session?.bridge?.close();
  }
  async close() {
    await Promise.all([...this.sessions.keys()].map(scope => this.reset(scope)));
    this.sessions.clear();
  }
}
