import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { agentFailure, agentStderrFailure } from './agent-diagnostics.mjs';

export class RpcProcess extends EventEmitter {
  constructor({ command, args, env, cwd }) {
    super();
    this.nextId = 0;
    this.pending = new Map();
    this.child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    // Never forward raw agent diagnostics to QQ or inherit the bot's secrets.
    let stderr = '';
    this.child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      const lines = stderr.split('\n'); stderr = lines.pop();
      for (const line of lines) {
        const error = agentStderrFailure(line);
        if (error) this.emit('diagnostic', error);
      }
    });
    this.child.stdin.on('error', () => this.fail(new Error('CODEX_CONNECTION_CLOSED')));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('CODEX_PROTOCOL_ERROR')); return; }
      if (message.method && message.id !== undefined) {
        if (/requestApproval$/.test(message.method)) {
          const result = message.method.includes('permissions') ? { permissions: {}, scope: 'turn' } : { decision: 'decline' };
          this.send({ id: message.id, result });
        } else if (message.method === 'mcpServer/elicitation/request') {
          this.send({ id: message.id, result: { action: 'decline', content: null } });
        } else this.send({ id: message.id, error: { code: -32601, message: 'Disabled by bot policy' } });
        return;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(agentFailure({ ...message.error,
          ...(message.error.data && typeof message.error.data === 'object' ? message.error.data : {}) }, 'CODEX_REQUEST_FAILED'),
        { rpcCode: message.error.code }));
        else pending.accept(message.result);
      } else if (message.method) this.emit('notification', message);
    });
    this.child.once('error', () => this.fail(new Error('CODEX_PROCESS_FAILED')));
    this.child.once('exit', () => this.fail(new Error('CODEX_PROCESS_EXITED')));
  }
  send(message) { if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('CODEX_CONNECTION_CLOSED'));
    const id = ++this.nextId;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CODEX_REQUEST_TIMEOUT')); }, timeout);
      this.pending.set(id, { accept, reject, timer });
      this.send({ id, method, params });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }
  close() {
    const exited = this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid
      ? Promise.resolve() : new Promise(accept => this.child.once('exit', accept));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 2000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
    this.fail(new Error('CODEX_CLOSED'));
    return exited;
  }
}

