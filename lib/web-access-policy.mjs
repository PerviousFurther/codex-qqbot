import { readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { webAccessState } from './web-access-state.mjs';
import domains from './web-domains/v2fly.json' with { type: 'json' };

// Compiled from the pinned public database and curated base; never changed by the model.
// Grants apply to project webpage acquisition, not Codex native search.
export const WEB_ALLOWED_DOMAINS = Object.freeze(domains.allowedDomains);
const allowed = new Set(WEB_ALLOWED_DOMAINS);
const adultDomains = new Set(domains.blockedDomains);
const adultExact = new Set(domains.blockedExact);
const adultPatterns = domains.blockedPatterns.map(pattern => new RegExp(pattern, 'i'));
const suffixMatch = (host, set) => {
  for (let value = host; value; value = value.includes('.') ? value.slice(value.indexOf('.') + 1) : '') {
    if (set.has(value)) return true;
  }
  return false;
};

export function assertNonAdultWebDomain(url) {
  const host = url.hostname.toLowerCase();
  if (host.length > 253) throw new Error('WEB_DOMAIN_NOT_ALLOWED');
  if (suffixMatch(host, adultDomains) || adultExact.has(host)
    || adultPatterns.some(pattern => pattern.test(host)) || domains.blockedKeywords.some(word => host.includes(word))) {
    throw new Error('WEB_ADULT_SITE_BLOCKED');
  }
  return url;
}

let approvalPath = null;
// Set only by trusted service/MCP startup, never from a model argument.
export function configureWebAccess(root) { approvalPath = join(root, 'web-access.json'); }
function approvedHosts() {
  if (!approvalPath) return [];
  let fd;
  try {
    fd = openSync(approvalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 65536) throw new Error('WEB_ACCESS_STATE_INVALID');
    let value;
    try { value = JSON.parse(readFileSync(fd, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('STATE_JSON_CORRUPT'); throw error; }
    return webAccessState(value).approved;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function assertAllowedWebDomain(url) {
  assertNonAdultWebDomain(url);
  if (!suffixMatch(url.hostname.toLowerCase(), allowed) && !approvedHosts().includes(url.hostname.toLowerCase())) {
    throw Object.assign(new Error('WEB_DOMAIN_NOT_ALLOWED'), { webDomain: url.hostname.toLowerCase() });
  }
  return url;
}
