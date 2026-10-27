import { isIP } from 'node:net';

// Only public DNS hostnames are review candidates; permission never skips DNS/IP checks.
export function approvalHost(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()
    || isIP(value) || !value.includes('.') || !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(value) || value.endsWith('.home.arpa')) {
    throw new Error('WEB_APPROVAL_HOST_INVALID');
  }
  return value;
}

export function webAccessState(value) {
  if (value === null) return { version: 1, approved: [], requests: [] };
  if (!value || !Object.keys(value).every(key => ['version', 'approved', 'requests'].includes(key)) || value.version !== 1 || !Array.isArray(value.approved) || !Array.isArray(value.requests)
    || value.approved.length > 500 || value.requests.length > 100) throw new Error('WEB_ACCESS_STATE_INVALID');
  try {
    for (const host of value.approved) approvalHost(host);
    const ids = new Set(), hosts = new Set();
    for (const request of value.requests) {
      if (!Object.keys(request).every(key => ['id', 'host', 'status', 'expiresAt'].includes(key))) throw new Error();
      approvalHost(request.host);
      if (!/^[a-f0-9]{32}$/.test(request.id) || !['pending', 'denied'].includes(request.status)
        || !Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0
        || ids.has(request.id) || hosts.has(request.host)) throw new Error();
      ids.add(request.id); hosts.add(request.host);
    }
    if (new Set(value.approved).size !== value.approved.length) throw new Error();
  } catch { throw new Error('WEB_ACCESS_STATE_INVALID'); }
  return value;
}
