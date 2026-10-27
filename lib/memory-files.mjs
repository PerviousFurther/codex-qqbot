import { lstat, readFile } from 'node:fs/promises';
import { WorkspaceFiles } from './workspace-files.mjs';
import { writeAtomic } from './store.mjs';

export const MEMORY_INSTRUCTIONS = await readFile(new URL('./memory/AGENTS.md', import.meta.url), 'utf8');

// Shared Markdown data only; the inherited access/path/size checks still apply.
export class MemoryFiles extends WorkspaceFiles {
  directoryParts() { return ['memory']; }
  name(name) {
    super.name(name);
    if (!name.endsWith('.md')) throw new Error('MEMORY_MARKDOWN_REQUIRED');
    return name;
  }
  async directory() {
    const directory = await super.directory();
    // Publish the shipped guide once; never replace existing memory at startup.
    const existing = await lstat(`${directory}/AGENTS.md`).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!existing) await writeAtomic(`${directory}/AGENTS.md`, MEMORY_INSTRUCTIONS, { replace: false })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
    return directory;
  }
  remove(name, expectedContent) {
    if (name.toLowerCase() === 'agents.md') throw new Error('MEMORY_GUIDE_READ_ONLY');
    return super.remove(name, expectedContent);
  }
  write(name, content, overwrite = false) {
    if (name.toLowerCase() === 'agents.md') throw new Error('MEMORY_GUIDE_READ_ONLY');
    return super.write(name, content, overwrite);
  }
}
