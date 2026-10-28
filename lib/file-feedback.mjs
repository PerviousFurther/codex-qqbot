import { fileType } from './file-codecs.mjs';

// Project only a bounded type label, never a filename, path or file body.
export function fileFeedback(item) {
  if (!['list_files', 'read_file', 'save_file', 'delete_file'].includes(item.tool)) return {};
  if (item.arguments?.area === 'memory') return { memoryNote: true };
  if (item.tool === 'list_files' || item.arguments?.area === 'assets') return {};
  const name = item.arguments?.name;
  if (typeof name !== 'string') return {};
  const { kind, extension } = fileType(name);
  if (!extension) return { fileKind: 'no_extension' };
  if (['md', 'markdown'].includes(extension)) return { memoryNote: true };
  if (extension === 'gif') return { fileKind: 'gif' };
  return { fileKind: kind, ...(kind === 'binary' && /^[a-z0-9]{1,16}$/.test(extension) ? { fileExtension: extension } : {}) };
}
