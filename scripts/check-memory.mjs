// Offline only: disposable files and fake model/transport; never reads runtime chats.
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { WorkspaceFiles } from '../lib/workspace-files.mjs';
import { MemoryFiles, MEMORY_INSTRUCTIONS } from '../lib/memory-files.mjs';
import { toolApprovals } from '../lib/tool-policy.mjs';
import { registerFileTools } from '../lib/tools/files.mjs';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-memory-check-'));
const store = new Store(root); const scope = 'group:fixture'; const id = scopeId(scope);
let controller;
try {
  const group = { id, openid: 'fixture', allowed: true, listen: true, engage: true,
    schedule: { warmup: true }, observedAt: new Date().toISOString() };
  await store.write(join(root, 'groups', `${id}.json`), group);
  const a = new MemoryFiles(store, scope); const b = new MemoryFiles(store, 'c2c:admin');
  assert.deepEqual((await a.list()).files.map(row => row.name), ['AGENTS.md']);
  assert.equal(await readFile(join(root, 'memory', 'AGENTS.md'), 'utf8'), MEMORY_INSTRUCTIONS);
  await a.write('knowledge.md', '# Useful public knowledge');
  assert.equal((await b.read('knowledge.md')).content, '# Useful public knowledge');
  await assert.rejects(b.write('knowledge.md', 'replacement'), /WORKSPACE_FILE_EXISTS/);
  await b.write('knowledge.md', 'corrected', true);
  assert.equal((await a.read('knowledge.md')).content, 'corrected');
  await new WorkspaceFiles(store, scope).write('local.md', 'scoped');
  await assert.rejects(a.read('local.md'), /ENOENT/);
  await WorkspaceFiles.clear(store, scope);
  assert.equal((await a.read('knowledge.md')).content, 'corrected');
  assert.throws(() => a.write('AGENTS.md', 'change', true), /MEMORY_GUIDE_READ_ONLY/);
  for (const name of ['../escape.md', '/memory/escape.md', '.hidden.md', 'code.js']) {
    assert.throws(() => a.write(name, 'data'), /WORKSPACE_NAME_INVALID|MEMORY_MARKDOWN_REQUIRED/);
  }
  assert.throws(() => a.write('huge.md', 'x'.repeat(65537)), /WORKSPACE_FILE_TOO_LARGE/);
  await symlink(join(root, 'memory', 'knowledge.md'), join(root, 'memory', 'symlink.md'));
  await assert.rejects(a.read('symlink.md'));
  await link(join(root, 'memory', 'knowledge.md'), join(root, 'memory', 'hardlink.md'));
  await assert.rejects(a.read('hardlink.md'), /WORKSPACE_REGULAR_FILE_REQUIRED/);
  await rm(join(root, 'memory', 'hardlink.md'));
  group.allowed = false; await store.write(join(root, 'groups', `${id}.json`), group);
  await assert.rejects(a.list(), /GROUP_MESSAGES_DISABLED/);
  group.allowed = true; await store.write(join(root, 'groups', `${id}.json`), group);
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: false });
  await assert.rejects(b.read('knowledge.md'), /PRIVATE_CHAT_DISABLED/);
  await store.write(join(root, 'chat-access.json'), { publicPrivateChat: true });
  const registered = [];
  registerFileTools(name => registered.push(name), { scope, store });
  assert.deepEqual(registered, ['list_files', 'read_file', 'save_file', 'delete_file']);
  for (const name of registered) assert(toolApprovals().enabled_tools.includes(name));

  // The real controller grants only discussion batches an admin alias. A source
  // switch changed while the outgoing message is queued must block submission.
  let phase = 'batch'; let sent = 0; const checked = [];
  const adapter = { reset: async () => {}, run: async options => {
    const aliases = options.replyTargets.map(target => target.id);
    if (phase === 'warmup') {
      assert.deepEqual(aliases, ['current']);
      await assert.rejects(options.onReply('help', 'admin:1'), /REPLY_TARGET_NOT_ALLOWED/);
    } else {
      assert.deepEqual(aliases, ['current', 'admin:1']);
      if (phase === 'revoked') {
        await assert.rejects(options.onReply('help', 'admin:1'), /GROUP_SENDING_PAUSED/);
      } else await options.onReply('help', 'admin:1');
    }
    checked.push(phase);
    return { sharedState: null };
  } };
  controller = new VideoController({ adapter, store, admins: ['admin'] });
  controller.sendRoutedReply = async (target, text, active, beforeSend, media, beforeCommit) => {
    await beforeSend();
    if (phase === 'revoked') await controller.groupAccess.update(id, row => { row.engage = false; });
    await beforeCommit(); sent++;
  };
  await controller.run(scope, 'fixture', {}, { background: true, purpose: 'batch', onReply: async () => {} });
  assert.equal(sent, 1);
  phase = 'warmup';
  await controller.run(scope, 'fixture', {}, { background: true, purpose: 'warmup', onReply: async () => {} });
  assert.equal(sent, 1);
  phase = 'revoked';
  await controller.run(scope, 'fixture', {}, { background: true, purpose: 'batch', onReply: async () => {} });
  assert.equal(sent, 1);
  assert.deepEqual(checked, ['batch', 'warmup', 'revoked']);
  // Generic source IDs, public projection, legacy data readability and stable
  // deduplication are checked using fresh records, never runtime state.
  const { History } = await import('../lib/history.mjs');
  const { GroupPush } = await import('../lib/group-push.mjs');
  const { ContentCleanup } = await import('../lib/content-cleanup.mjs');
  const history = new History(store);
  const content = await store.remember(scope, { url: 'https://github.com/fixture/article', kind: 'webpage',
    title: 'Public article', summary: 'Observed facts', comment: 'A short review', uncertainty: 'Scoped evidence gap',
    observations: [{ seconds: 1, text: 'Scoped observation' }] });
  assert.match(content.id, /^[a-f0-9]{32}$/);
  assert.equal((await store.memories(scope)).find(item => item.id === content.id).url, content.url);
  assert.equal((await history.records('public article'))[0].id, content.id);
  assert(!JSON.stringify(await history.records()).includes('Scoped'));
  assert((await history.menu()).buttons.rows.flat().some(button => button.command === `/content ${content.id}`));
  await assert.rejects(store.remember(scope, { url: 'https://github.com/file?access_token=private', title: 'Private', summary: 'x' }), /CONTENT_PRIVATE_URL/);
  const legacyId = 'BV1234567890';
  await store.write(store.contentPath(scope, legacyId), { bvid: legacyId, title: 'Saved video', summary: 'Existing facts',
    updatedAt: new Date().toISOString() });
  await history.indexSavedContent();
  const legacy = (await history.records()).find(item => item.id === legacyId);
  assert.equal(legacy.url, `https://www.bilibili.com/video/${legacyId}/`);
  const revised = await store.remember(scope, { url: legacy.url, kind: 'video', title: 'Saved video', summary: 'Updated public facts' });
  assert.equal(revised.id, legacyId);
  assert.equal((await history.records()).filter(item => item.url === legacy.url).length, 1);
  let deliveryCount = 0;
  const target = { openid: 'fixture', allowed: true, push: true, delivered: [legacyId] };
  const push = new GroupPush({ update: async (_id, change) => { change(target); return target; }, read: async () => target }, {},
    async () => { deliveryCount++; }, () => '', () => {});
  assert.equal(await push.deliver('fixture', [revised]), false);
  assert.equal(await push.deliver('fixture', [content]), true);
  assert.equal(deliveryCount, 1); assert(target.delivered.includes(content.id));
  const cleanup = new ContentCleanup(store, () => {});
  await store.write(cleanup.path, { enabled: false, nextAt: 123 });
  assert.deepEqual(await cleanup.read(), { enabled: false, nextAt: 123 });
  assert.equal((await cleanup.clean(0)).history, 0);
  const cleared = await cleanup.clean(Infinity);
  assert.equal(cleared.history, 2); assert.equal((await history.records()).length, 0);
  await cleanup.close();
  console.log('Offline shared-memory, generic content history/deduplication, legacy readability and administrator-help checks passed.');
} finally {
  await controller?.groupContext.close();
  await rm(root, { recursive: true, force: true });
}
