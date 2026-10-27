import domains from './web-domains/v2fly.json' with { type: 'json' };

// Compiled from the pinned public database and curated base; never changed by the model.
// All grants are suffix rules, shared with native search. Exact-only grants are omitted.
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

export function assertAllowedWebDomain(url) {
  const host = url.hostname.toLowerCase();
  if (host.length > 253) throw new Error('WEB_DOMAIN_NOT_ALLOWED');
  if (suffixMatch(host, adultDomains) || adultExact.has(host)
    || adultPatterns.some(pattern => pattern.test(host)) || domains.blockedKeywords.some(word => host.includes(word))) {
    throw new Error('WEB_ADULT_SITE_BLOCKED');
  }
  if (!suffixMatch(host, allowed)) throw new Error('WEB_DOMAIN_NOT_ALLOWED');
  return url;
}
