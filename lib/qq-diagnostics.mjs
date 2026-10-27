import { AsyncLocalStorage } from 'node:async_hooks';

// Validate HTTP-success responses too: QQ can return a business error with HTTP 200.
export function checkedQQReply(response) {
  const code = response?.err_code ?? response?.code;
  if (code) throw Object.assign(new Error('QQ_REPLY_REJECTED'), {
    name: 'QQReplyError', httpStatus: 200, bizCode: code,
    bizMessage: response.message, traceId: response.trace_id,
  });
  return response;
}

export function markdownUnsupported(error) {
  return ((error?.name === 'ApiError' && [400, 403].includes(error.httpStatus))
    || error?.name === 'QQReplyError') && [50056, 304036].includes(error.bizCode);
}

// QQ's send API documents 22009 as "msg limit exceed". HTTP 429 is also explicit throttling.
export function qqReplyLimited(error) {
  return error?.message === 'QQ_RATE_LIMITED' || error?.httpStatus === 429 || Number(error?.bizCode) === 22009;
}

// Only structured, bounded platform metadata crosses the model-tool boundary.
export function qqRateLimitDetails(error) {
  if (!qqReplyLimited(error)) return {};
  return { delivery: 'rejected', rate_limited: true, platform: {
    ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isInteger(error.bizCode) ? { bizCode: error.bizCode } : {}),
    ...(typeof error.traceId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(error.traceId) ? { traceId: error.traceId } : {}),
  } };
}

export class QQDiagnostics {
  constructor(secret, onState) {
    this.secret = secret;
    this.apiContext = new AsyncLocalStorage();
    // The SDK exposes response-header Trace IDs through its logger, not ApiError.
    // AsyncLocalStorage keeps concurrent requests from borrowing another request's ID.
    this.logger = {
      info: text => {
        const traceId = /^\[qqbot:api\] <<< Status: .*\| TraceId: ([a-zA-Z0-9_-]+)$/.exec(text)?.[1];
        const context = this.apiContext.getStore();
        if (traceId && context) context.traceId = traceId;
      },
      error: text => onState('sdk_error', this.errorDetails({ bizMessage: String(text) })),
    };
  }
  async call(operation) {
    return this.apiContext.run({}, async () => {
      try { return checkedQQReply(await operation()); }
      catch (error) {
        const traceId = this.apiContext.getStore()?.traceId;
        if (traceId && !error.traceId) error.traceId = traceId;
        throw error;
      }
    });
  }
  errorDetails(error) {
    const description = typeof error.bizMessage === 'string'
      ? error.bizMessage.split(this.secret).join('[已隐藏]').replace(/[\r\n]+/g, ' ').slice(0, 500)
      : error.httpStatus === 0 ? '网络异常或超时，无法确认消息是否送达。'
      : '平台未返回错误说明。';
    return { description,
      ...(['file_upload', 'file_send'].includes(error.diagnosticStage) ? { kind: error.diagnosticStage } : {}),
      ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}),
      ...(Number.isInteger(error.bizCode) ? { bizCode: error.bizCode } : {}),
      ...(typeof error.traceId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(error.traceId) ? { traceId: error.traceId } : {}),
    };
  }
  format(title, error) {
    const details = this.errorDetails(error);
    return [title, `HTTP：${details.httpStatus ?? '未返回'}`, `错误码：${details.bizCode ?? '未返回'}`,
      ...(details.bizCode === 40034105 ? ['处理建议：QQ拒绝主动发送，请检查目标会话是否允许机器人主动发言；这不是B站或Codex登录错误。'] : []),
      `平台说明：${details.description}`, `Trace ID：${details.traceId ?? '未返回'}`].join('\n');
  }
}
