// Offline compilation and access checks: synthetic rules, no network/browser/model calls.
import assert from 'node:assert/strict';
import { compileDomains, allowedCategories, blockedCategories } from './lib/v2fly-domains.mjs';
import { validatePublicURL } from '../lib/public-resource.mjs';
import { WEB_ALLOWED_DOMAINS } from '../lib/web-access-policy.mjs';
import snapshot from '../lib/web-domains/v2fly.json' with { type: 'json' };
import base from '../lib/web-domains/base.json' with { type: 'json' };

const fixture = {
  allow: 'include:child @-!cn\ninclude:tagged\ncom\nfull:exact.example\nkeyword:unsafe\nregexp:.*\\.unsafe\\.example$\nonlyfans.example\nshared.example\nfilter.example @ads\n',
  child: 'good.example\nexcluded.example @!cn\ninclude:nested\n',
  nested: 'nested.example @cn\n',
  tagged: 'include:tagged-child @cn\n',
  'tagged-child': 'chosen.example @cn\nunchosen.example\n',
  affiliation: 'affiliated.example &child\n',
  adult: 'include:adult-child\nfull:adult.shared.example\nregexp:(^|\\.)adult[0-9]+\\.example$\n',
  'adult-child': 'onlyfans.example\n',
};
const result = compileDomains(fixture, ['base.example'], { allow: ['allow'], block: ['adult'] });
assert.deepEqual(result.allowedDomains, ['affiliated.example', 'base.example', 'chosen.example', 'good.example', 'nested.example']);
assert.equal(result.omittedAllowRules.topLevel, 1); assert.equal(result.omittedAllowRules.exact, 1); assert.equal(result.omittedAllowRules.keyword, 1); assert.equal(result.omittedAllowRules.regexp, 1);
assert(result.blockedExact.includes('adult.shared.example'));
assert.throws(() => compileDomains({ a: 'include:b', b: 'include:a' }, [], { allow: ['a'], block: ['a'] }), /CYCLE/);
assert.throws(() => compileDomains({ a: 'include:missing' }, [], { allow: ['a'], block: ['a'] }), /MISSING/);
assert.throws(() => compileDomains({ a: 'domain:127.0.0.1' }, [], { allow: ['a'], block: ['a'] }), /RULE_INVALID/);
assert.throws(() => compileDomains({ a: 'good.example @bad_field' }, [], { allow: ['a'], block: ['a'] }), /FIELD_INVALID/);
assert.deepEqual(snapshot.allowedCategories, allowedCategories); assert.deepEqual(snapshot.blockedCategories, blockedCategories);
for (const host of ['reddit.com', 'www.reddit.com', 'x.com', 'weibo.com', 'xiaohongshu.com', 'v2ex.com', 'ptt.cc', 'hupu.com', 'github.com', 'bilibili.com']) {
  assert.equal(validatePublicURL(`https://${host}/`).hostname, host);
}
for (const host of ['onlyfans.com', 'fansly.com', 'sis001.com', 'pornhub.com', 'www.xvideos.com']) {
  assert.throws(() => validatePublicURL(`https://${host}/`), /WEB_ADULT_SITE_BLOCKED/);
}
for (const domain of base) assert(WEB_ALLOWED_DOMAINS.includes(domain));
assert.throws(() => validatePublicURL('https://1gaoap.com/'), /WEB_ADULT_SITE_BLOCKED/);
assert.throws(() => validatePublicURL('https://anime-rule34-world.b-cdn.net/'), /WEB_ADULT_SITE_BLOCKED/);
assert.throws(() => validatePublicURL('https://child.anime-rule34-world.b-cdn.net/'), /WEB_DOMAIN_NOT_ALLOWED/);
assert.throws(() => validatePublicURL('https://bbs.boingboing.net/'), /WEB_DOMAIN_NOT_ALLOWED/); // Exact-only allow omitted.
assert.throws(() => validatePublicURL('https://v2ex.com.evil.example/'), /WEB_DOMAIN_NOT_ALLOWED/);
for (const root of WEB_ALLOWED_DOMAINS) {
  assert(!snapshot.blockedDomains.some(host => host === root || host.endsWith(`.${root}`)));
  assert(!snapshot.blockedExact.some(host => host === root || host.endsWith(`.${root}`)));
}
console.log('Offline domain checks passed: include filters/affiliations, exact-rule omission, denied-parent conflicts, adult blocks, category grants and unchanged base sites.');
