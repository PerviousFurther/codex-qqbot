import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeId } from './policy.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { writeAtomic } from './store.mjs';
import { SerialQueue } from './serial-queue.mjs';

const MAX_BYTES = 64 * 1024;

// Data files only. This directory is never a process cwd, module path or executable input.
export class WorkspaceFiles {
  constructor(store, scope) {
    this.store = store; this.scope = scope; this.queue = new SerialQueue();
  }
  name(name) {
    if (typeof name !== 'string' || !name || name.startsWith('.')
      || /[/\\\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 180) throw new Error('WORKSPACE_NAME_INVALID');
    return name;
  }
  directoryParts() { return ['workspace', scopeId(this.scope)]; }
  async directory() {
    await assertMessageAccess(this.scope, this.store);
    await mkdir(this.store.root, { recursive: true, mode: 0o700 });
    let path = await realpath(this.store.root);
    for (const part of this.directoryParts()) {
      path = join(path, part);
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('WORKSPACE_DIRECTORY_INVALID');
    }
    return path;
  }
  async entries(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      files.push({ name: entry.name, bytes: (await lstat(join(directory, entry.name))).size });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
  async list() {
    const files = await this.entries(await this.directory());
    await assertMessageAccess(this.scope, this.store);
    return { files, max_file_bytes: MAX_BYTES, untrusted: true };
  }
  async readText(name) {
    this.name(name);
    const directory = await this.directory();
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (await realpath(`/proc/self/fd/${file.fd}`) !== join(directory, name)) throw new Error('WORKSPACE_DIRECTORY_INVALID');
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('WORKSPACE_REGULAR_FILE_REQUIRED');
      if (info.size > MAX_BYTES) throw new Error('WORKSPACE_FILE_TOO_LARGE');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error('WORKSPACE_FILE_TOO_LARGE');
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      if (content.includes('\0')) throw new Error('WORKSPACE_TEXT_REQUIRED');
      await assertMessageAccess(this.scope, this.store);
      return content;
    } finally { await file.close(); }
  }
  async read(name, startLine = 1, maxLines = 100) {
    const content = await this.readText(name);
    const lines = content.split(/\r?\n/);
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
    return { name, start_line: startLine, total_lines: lines.length, content: selected.slice(0, 12000),
      truncated: startLine - 1 + maxLines < lines.length || selected.length > 12000, untrusted: true };
  }
  remove(name, expectedContent) {
    this.name(name);
    return this.queue.run(async () => {
      const directory = await this.directory();
      const content = await this.readText(name);
      if (content !== expectedContent) throw new Error('WORKSPACE_FILE_CHANGED');
      await assertMessageAccess(this.scope, this.store);
      await unlink(join(directory, name));
      return { deleted: true };
    });
  }
  write(name, content, overwrite = false) {
    this.name(name);
    if (typeof content !== 'string' || content.includes('\0')) throw new Error('WORKSPACE_TEXT_REQUIRED');
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('WORKSPACE_FILE_TOO_LARGE');
    return this.queue.run(async () => {
      const directory = await this.directory();
      const path = join(directory, name);
      const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('WORKSPACE_REGULAR_FILE_REQUIRED');
      if (info && !overwrite) throw new Error('WORKSPACE_FILE_EXISTS');
      await assertMessageAccess(this.scope, this.store);
      await writeAtomic(path, content, { replace: overwrite });
      return { name, bytes: Buffer.byteLength(content), written: true };
    });
  }
  static clear(store, scope) {
    return rm(join(store.root, 'workspace', scopeId(scope)), { recursive: true, force: true });
  }
}
