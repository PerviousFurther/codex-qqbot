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
  console.log('Offline shared-memory and group administrator-help checks passed.');
} finally {
  await controller?.groupContext.close();
  await rm(root, { recursive: true, force: true });
}
