import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactCredentials } from './policy.mjs';

const directories = new Set(['lib', 'scripts', 'deploy', 'docs']);
const rootFiles = new Set(['README.md', 'AGENTS.md', 'Dockerfile', 'compose.yaml', 'package.json', 'package-lock.json']);
const excluded = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'data', 'logs', 'artifacts']);
function permitted(path, directory = false) {
  const parts = path.split('/');
  if (parts.some(part => !part || part.startsWith('.') || excluded.has(part))) return false;
  if (parts.length === 1 && rootFiles.has(path)) return !directory;
  if (!directories.has(parts[0])) return false;
  return directory || /\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|md|txt|rst|adoc|json|yaml|yml|toml|html|css|svg)$/i.test(path)
    && !/^(?:auth|credentials?|secrets?|tokens?)(?:[._-]|$)/i.test(parts.at(-1));
}

// Read source and documentation only. No arbitrary paths, symlinks, or special files.
export class ProjectFiles {
  constructor(root) { this.root = resolve(root); }
  async path(path, directory = false) {
    if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.includes('\0')
      || !permitted(path, directory)) throw new Error('PROJECT_FILE_NOT_ALLOWED');
    const root = await realpath(this.root);
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('PROJECT_SYMLINK_NOT_ALLOWED');
    }
    const canonical = await realpath(current);
    const inside = relative(root, canonical);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error('PROJECT_FILE_NOT_ALLOWED');
    }
    return canonical;
  }
  async list(query = '') {
    const files = [];
    let truncated = false;
    let visited = 0;
    const visit = async (directory, prefix = '', depth = 0) => {
      if (depth > 12) { truncated = true; return; }
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= 200 || ++visited > 2000) { truncated = true; return; }
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && permitted(path, true)) {
          await visit(await this.path(path, true), path, depth + 1);
        } else if (entry.isFile() && permitted(path) && path.toLowerCase().includes(query.toLowerCase())) {
          files.push(path);
        }
      }
    };
    await visit(await realpath(this.root));
    return { files, truncated };
  }
  async read(path, startLine = 1, maxLines = 100) {
    const canonical = await this.path(path);
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = relative(await realpath(this.root), await realpath(`/proc/self/fd/${file.fd}`));
      if (isAbsolute(actual) || actual.startsWith(`..${sep}`) || !permitted(actual)) {
        throw new Error('PROJECT_FILE_NOT_ALLOWED');
      }
      const info = await file.stat();
      if (!info.isFile()) throw new Error('PROJECT_REGULAR_FILE_REQUIRED');
      if (info.size > 256 * 1024) throw new Error('PROJECT_FILE_TOO_LARGE');
      const content = Buffer.alloc(Math.min(info.size + 1, 256 * 1024 + 1));
      const { bytesRead } = await file.read(content, 0, content.length, 0);
      if (bytesRead > 256 * 1024) throw new Error('PROJECT_FILE_TOO_LARGE');
      const text = content.subarray(0, bytesRead).toString('utf8');
      if (text.includes('\0')) throw new Error('PROJECT_TEXT_FILE_REQUIRED');
      const lines = text.split(/\r?\n/);
      const selected = redactCredentials(lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n'));
      return { path, startLine, totalLines: lines.length, content: selected.slice(0, 12000),
        truncated: startLine - 1 + maxLines < lines.length || selected.length > 12000 };
    } finally { await file.close(); }
  }
}
