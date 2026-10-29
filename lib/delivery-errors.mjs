// Stable delivery rejection contract; channel adapters normalize protocol-specific errors.
export function deliveryRateLimited(error) {
  return error?.message === 'QQ_RATE_LIMITED' || error?.httpStatus === 429;
}
export function deliveryRateLimitDetails(error) {
  if (!deliveryRateLimited(error)) return {};
  return { delivery: 'rejected', rate_limited: true, platform: deliveryMetadata(error) };
}
function deliveryMetadata(error) {
  return {
    ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isInteger(error?.bizCode) ? { bizCode: error.bizCode } : {}),
    ...(typeof error?.traceId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(error.traceId) ? { traceId: error.traceId } : {}),
  };
}
export class DeliveryDiagnostics {
  isRateLimited(error) { return deliveryRateLimited(error); }
  errorDetails(error) { return deliveryMetadata(error); }
  format(title, error) {
    const details = this.errorDetails(error);
    return [title, `HTTP：${details.httpStatus ?? '未返回'}`, `错误码：${details.bizCode ?? '未返回'}`].join('\n');
  }
}
