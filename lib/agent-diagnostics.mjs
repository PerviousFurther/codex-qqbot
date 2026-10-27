// Recovery is based on structured codes, never on user-message keywords.
export function recoveryFor(error) {
  if (error?.message === 'STATE_JSON_CORRUPT') return { kind: 'blocked' };
  if (error?.message === 'REASONING_EFFORT_UNAVAILABLE') return { kind: 'blocked' };
  const code = String(error?.agentCode ?? '').toLowerCase();
  const status = error?.upstreamStatus;
  if (['unauthorized', 'usagelimitexceeded', 'badrequest', 'sandboxerror'].includes(code)
    || [401, 403].includes(status)) return { kind: 'blocked' };
  if (code === 'contextwindowexceeded') return { kind: 'context' };
  if (['httpconnectionfailed', 'responsestreamconnectionfailed', 'responsestreamdisconnected',
    'responsetoomanyfailedattempts', 'internalservererror'].includes(code)
    || status === 429 || status >= 500
    || /^CODEX_(?:TURN_TIMEOUT|PROCESS_EXITED|CONNECTION_CLOSED|REQUEST_TIMEOUT)$/.test(error?.message ?? '')) {
    return { kind: 'connection' };
  }
  if (['SESSION_LIMIT_REACHED', 'CONVERSATION_BUSY'].includes(error?.message)) return { kind: 'busy' };
  return { kind: 'task' };
}

// Forward structured error categories, never raw upstream bodies or protocol dumps.
export function agentFailure(error, fallback = 'CODEX_TURN_FAILED') {
  const info = error?.codexErrorInfo;
  const variant = typeof info === 'string' ? info : info && Object.keys(info)[0];
  const fields = typeof info === 'object' && info ? info[variant] : null;
  const status = fields?.httpStatusCode ?? info?.httpStatusCode;
  const code = /^[a-zA-Z][a-zA-Z0-9]{1,64}$/.test(variant ?? '') ? variant : undefined;
  const routingFailed = /workspace routing discovery failed/i.test(error?.message ?? '');
  return Object.assign(new Error(fallback), {
    ...(code ? { agentCode: code } : routingFailed ? { agentCode: 'httpConnectionFailed' } : {}),
    ...(Number.isInteger(status) ? { upstreamStatus: status } : {}),
  });
}

// Recognize fixed stderr signatures only. Raw lines may contain prompts or URLs.
export function agentStderrFailure(line) {
  const agentCode = /refresh_token_(?:reused|expired|invalidated)|authentication token.*(?:expired|invalid)/i.test(line) ? 'unauthorized'
    : /workspace routing discovery failed|error sending request|connection (?:refused|reset)|dns error|network is unreachable/i.test(line) ? 'httpConnectionFailed'
    : /stream disconnected before completion/i.test(line) ? 'responseStreamDisconnected'
    : /(?:request|connection|operation) timed out|request timeout/i.test(line) ? 'responseStreamConnectionFailed' : null;
  return agentCode ? Object.assign(new Error('CODEX_UPSTREAM_ERROR'), { agentCode }) : null;
}
