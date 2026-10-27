// Explicit offline operator step: compile the pinned checkout; never fetch at runtime.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeAtomic } from '../lib/store.mjs';
import { allowedCategories, blockedCategories, blockedOverrides, compileDomains } from './lib/v2fly-domains.mjs';

const checkout = fileURLToPath(new URL('../vendor/v2fly-domain-list-community/', import.meta.url));
const git = args => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
if (git(['remote', 'get-url', 'origin']) !== 'https://github.com/v2fly/domain-list-community.git'
  || git(['status', '--porcelain'])) throw new Error('DOMAIN_CHECKOUT_NOT_CLEAN');
const revision = git(['rev-parse', 'HEAD']);
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('DOMAIN_REVISION_INVALID');
const files = Object.create(null); const digest = createHash('sha256');
for (const name of (await readdir(`${checkout}data`)).sort()) {
  const path = `${checkout}data/${name}`;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('DOMAIN_SOURCE_INVALID');
  files[name] = await readFile(path, 'utf8');
  digest.update(name + '\0' + files[name] + '\0');
}
const base = JSON.parse(await readFile(new URL('../lib/web-domains/base.json', import.meta.url), 'utf8'));
const policy = compileDomains(files, base);
const license = await readFile(`${checkout}LICENSE`, 'utf8');
if (license !== await readFile(new URL('../lib/web-domains/LICENSE.v2fly.txt', import.meta.url), 'utf8')) throw new Error('DOMAIN_LICENSE_CHANGED');
const data = { source: 'https://github.com/v2fly/domain-list-community', revision, sourceSha256: digest.digest('hex'),
  allowedCategories, blockedCategories, blockedOverrides, ...policy };
const encoded = JSON.stringify(data, null, 2) + '\n';
const path = fileURLToPath(new URL('../lib/web-domains/v2fly.json', import.meta.url));
if (process.argv.slice(2).length && process.argv.slice(2).join(' ') !== '--check') throw new Error('USAGE: node scripts/update-web-domains.mjs [--check]');
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== encoded) throw new Error('DOMAIN_SNAPSHOT_OUTDATED');
} else {
  await writeAtomic(path, encoded);
  // Public build input must be readable by the non-root container user after COPY.
  await chmod(path, 0o644);
}
console.log(JSON.stringify({ revision, allowed: policy.allowedDomains.length, adultDomains: policy.blockedDomains.length,
  adultExact: policy.blockedExact.length, omitted: policy.omittedAllowRules, adultConflicts: policy.removedAdultConflicts.length }));
