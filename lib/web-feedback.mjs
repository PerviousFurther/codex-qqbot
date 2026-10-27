import { assertNonAdultWebDomain } from './web-access-policy.mjs';
import { isIP } from 'node:net';
import { redactCredentials } from './policy.mjs';

// Ephemeral administrator feedback only; never pass these URLs to diagnostics.
export function webFeedbackUrls(values = []) {
  const urls = new Set();
  for (const value of values.slice(0, 40)) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(value)) continue;
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) continue;
      if (!url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, ''))
        || /\.(?:local|localhost|internal|invalid|test)$/i.test(url.hostname)) continue;
      assertNonAdultWebDomain(url);
      url.search = ''; url.hash = '';
      const safe = redactCredentials(url.href);
      if (safe !== url.href || safe.length > 500) continue;
      urls.add(safe);
      if (urls.size === 3) break;
    } catch {}
  }
  return [...urls];
}
