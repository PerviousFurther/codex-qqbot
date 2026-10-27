import { contentCodecs } from './content-codecs.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { GroupContext } from './group-context.mjs';
import { groupPolicy } from './group-policy.mjs';
import { scopeId } from './policy.mjs';
import { toolFailure } from './tools/register.mjs';

// Native messages may contain SQL, paths or record contents. Report fixed categories only.
function groupMemoryFailure(error) {
  const sqliteCodes = { 5: 'BUSY', 6: 'LOCKED', 8: 'READONLY', 10: 'IO', 11: 'CORRUPT',
    13: 'FULL', 14: 'CANTOPEN', 26: 'NOTADB' };
  const sqlite = Number.isInteger(error?.errcode) ? sqliteCodes[error.errcode & 255] : null;
  const code = error?.code === 'ERR_SQLITE_ERROR'
    ? `GROUP_MEMORY_DATABASE_${sqlite ?? 'FAILED'}`
    : ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'ENOENT'].includes(error?.code)
      ? `GROUP_MEMORY_STORAGE_${error.code}` : null;
  const classified = code ?? (/^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? '') ? error.message
    : /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.code ?? '') ? error.code : 'GROUP_MEMORY_INTERNAL_FAILED');
  return toolFailure(new Error(classified),
    '群记录仅限当前群且需开启采集。数据库或存储失败时停止本次读取并告知机管，不自动重试或清空记录；摘要失效时重新读取。不能猜测缺失内容或绕过权限。');
}

export function registerGroupMemory(registerTool, scope, store) {
  const register = (...args) => registerTool(...args, groupMemoryFailure);
  const context = new GroupContext(store);
  const receipts = new Map();
  const assertAccess = async () => {
    const group = await store.read(join(store.root, 'groups', `${scopeId(scope)}.json`), null);
    if (!group?.allowed || !group.listen) throw new Error('GROUP_MEMORY_DISABLED');
    return group;
  };
  register('recall_group_context', 'Query retained text in THIS group only by member OpenID, keyword, ISO-8601 time range, or revision cursor. Omitted since defaults to the configured recent-context window (10 minutes). Explicit ISO time ranges may retrieve older retained originals. To prepare compression, set for_compaction=true and optionally until: returns the next complete unsummarized prefix, previous summary, and a compaction_token. For normal queries paginate with nextBeforeRevision; for compaction save the returned batch before preparing the next prefix. No other groups or private chats are accessible.', {
    openid: z.string().max(128).default(''), query: z.string().max(80).default(''),
    since: z.string().max(40).default(''), until: z.string().max(40).default(''),
    before_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(40).default(20), for_compaction: z.boolean().default(false),
  }, async args => {
    const group = await assertAccess();
    const filters = !args.for_compaction && !args.since
      ? { ...args, since: new Date(Date.now() - groupPolicy(group).contextMinutes * 60000).toISOString() } : args;
    const result = await context.recall(scope, filters);
    await assertAccess();
    const receipt = result.receipt; delete result.receipt;
    if (receipt) {
      const token = randomUUID();
      receipts.set(token, { ...receipt, expiresAt: Date.now() + 600000 });
      while (receipts.size > 4) receipts.delete(receipts.keys().next().value);
      result.compaction_token = token;
    }
    return [contentCodecs.value('json', result)];
  });
  register('compact_group_context', 'Save a factual cumulative summary of this group after reading an unfiltered compaction batch. Merge the previous summary and all messages in that batch; retain speaker attribution, decisions and unresolved questions. Use its exact compaction_token. Does not delete retained original messages or alter identities. Queues Codex thread compaction after the current turn completes; it does not interrupt the active turn. On stale/expired input, query again.', {
    compaction_token: z.string().uuid(), summary: z.string().min(1).max(1500),
  }, async args => {
    await assertAccess();
    const receipt = receipts.get(args.compaction_token);
    if (!receipt || receipt.expiresAt <= Date.now()) throw new Error('GROUP_COMPACTION_TOKEN_EXPIRED');
    const result = await context.compact(scope, receipt, args.summary);
    receipts.delete(args.compaction_token);
    return [contentCodecs.value('json', result)];
  });
  return () => context.close();
}
