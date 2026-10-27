import { isIP } from 'node:net';

export const allowedCategories = Object.freeze([
  'category-forums', 'category-forums-ir', 'category-forums-ru',
  'category-social-media-cn', 'category-social-media-!cn', 'category-social-media-ir',
]);
export const blockedCategories = Object.freeze(['category-porn']);
// Known adult platforms missing from the upstream adult category.
export const blockedOverrides = Object.freeze(['fansly.com', 'onlyfans.com']);

const namePattern = /^[a-z0-9!][a-z0-9!-]*$/;
const attributePattern = /^!?[a-z0-9][a-z0-9!-]*$/;
export function validDomain(value) {
  return typeof value === 'string' && value.length <= 253 && !isIP(value)
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
const below = (host, root) => host === root || host.endsWith(`.${root}`);

// Offline compiler only. Never execute upstream data or broaden an exact/regex rule.
export function compileDomains(files, base, { allow = allowedCategories, block = blockedCategories, extraBlocked = blockedOverrides } = {}) {
  const parsed = new Map();
  const list = name => {
    if (!namePattern.test(name)) throw new Error('DOMAIN_LIST_NAME_INVALID');
    if (!parsed.has(name)) parsed.set(name, { entries: [], includes: [] });
    return parsed.get(name);
  };
  for (const [name, source] of Object.entries(files)) {
    const target = list(name);
    for (const [index, raw] of source.split(/\r?\n/).entries()) {
      const parts = raw.split('#')[0].trim().split(/\s+/);
      if (!parts[0]) continue;
      const first = parts.shift();
      const colon = first.indexOf(':');
      const type = colon < 0 ? 'domain' : first.slice(0, colon).toLowerCase();
      let value = colon < 0 ? first : first.slice(colon + 1);
      if (['domain', 'full', 'include'].includes(type)) value = value.toLowerCase();
      const attrs = []; const affiliations = [];
      for (const part of parts) {
        if (part.startsWith('@') && attributePattern.test(part.slice(type === 'include' && part.startsWith('@-') ? 2 : 1))) attrs.push(part.slice(1));
        else if (type !== 'include' && part.startsWith('&') && namePattern.test(part.slice(1))) affiliations.push(part.slice(1));
        else throw new Error(`DOMAIN_RULE_FIELD_INVALID:${name}:${index + 1}`);
      }
      if (type === 'include') {
        if (!namePattern.test(value)) throw new Error('DOMAIN_INCLUDE_INVALID');
        target.includes.push({ name: value, attrs }); continue;
      }
      if (!['domain', 'full', 'keyword', 'regexp'].includes(type) || !value
        || ['domain', 'full'].includes(type) && !validDomain(value)) throw new Error(`DOMAIN_RULE_INVALID:${name}:${index + 1}`);
      const entry = { type, value, attrs };
      target.entries.push(entry);
      for (const affiliation of affiliations) list(affiliation).entries.push(entry);
    }
  }
  const cache = new Map(); const visiting = new Set();
  const resolve = name => {
    if (cache.has(name)) return cache.get(name);
    if (visiting.has(name)) throw new Error('DOMAIN_INCLUDE_CYCLE');
    const target = parsed.get(name);
    if (!target) throw new Error(`DOMAIN_LIST_MISSING:${name}`);
    visiting.add(name);
    const entries = [...target.entries];
    for (const include of target.includes) entries.push(...resolve(include.name).filter(entry => include.attrs.every(attr =>
      attr.startsWith('-') ? !entry.attrs.includes(attr.slice(1)) : entry.attrs.includes(attr))));
    visiting.delete(name);
    const distinct = [...new Map(entries.map(entry => [JSON.stringify(entry), entry])).values()];
    cache.set(name, distinct); return distinct;
  };
  const denied = block.flatMap(resolve);
  if (!extraBlocked.every(validDomain)) throw new Error('DOMAIN_BLOCK_OVERRIDE_INVALID');
  const blockedDomains = [...new Set([...extraBlocked, ...denied.filter(entry => entry.type === 'domain').map(entry => entry.value)])].sort();
  const blockedExact = [...new Set(denied.filter(entry => entry.type === 'full').map(entry => entry.value))].sort();
  const blockedPatterns = [...new Set(denied.filter(entry => entry.type === 'regexp').map(entry => entry.value))].sort();
  const blockedKeywords = [...new Set(denied.filter(entry => entry.type === 'keyword').map(entry => entry.value))].sort();
  // These pinned upstream deny patterns are only filters, never permission grants.
  const patterns = blockedPatterns.map(pattern => new RegExp(pattern, 'i'));
  const blocked = host => blockedDomains.some(domain => below(host, domain)) || blockedExact.includes(host)
    || patterns.some(pattern => pattern.test(host)) || blockedKeywords.some(word => host.includes(word));
  const selected = allow.flatMap(resolve);
  const suffixes = selected.filter(entry => entry.type === 'domain' && entry.value.includes('.') && !entry.attrs.includes('ads')).map(entry => entry.value);
  if (!base.every(domain => validDomain(domain) && domain.includes('.'))) throw new Error('DOMAIN_BASE_INVALID');
  const removed = [];
  const allowedDomains = [...new Set([...base, ...suffixes])].filter(domain => {
    // Native search accepts suffixes. Omit whole parents containing known denied hosts,
    // rather than granting an adult descendant to search while blocking it in downloads.
    const conflict = blocked(domain) || [...blockedDomains, ...blockedExact].some(host => below(host, domain));
    if (conflict) removed.push(domain);
    return !conflict;
  }).sort();
  if (!allowedDomains.length || !blockedDomains.length) throw new Error('DOMAIN_POLICY_EMPTY');
  return { allowedDomains, blockedDomains, blockedExact, blockedPatterns, blockedKeywords,
    omittedAllowRules: { topLevel: selected.filter(entry => entry.type === 'domain' && !entry.value.includes('.')).length, exact: selected.filter(entry => entry.type === 'full').length,
      keyword: selected.filter(entry => entry.type === 'keyword').length, regexp: selected.filter(entry => entry.type === 'regexp').length },
    removedAdultConflicts: removed.sort() };
}
