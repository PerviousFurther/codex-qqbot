import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoredFiles } from './stored-files.mjs';
import { MemoryFiles } from './memory-files.mjs';
import { contentCodecs } from './content-codecs.mjs';
import { fileType } from './file-codecs.mjs';
import { FileMediaEncoder } from './file-media-encoder.mjs';
import { downloadPublicResource } from './public-resource.mjs';
import { downloadQQMedia } from './qq-images.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { writeAtomic } from './store.mjs';

// Acquisition adapters stream authorized bytes into a source-independent consumer.
export class Files {
  constructor({ scope, store, records, savedImages, messageImages, encoder = new FileMediaEncoder(), downloadPublic = downloadPublicResource, downloadQQ = downloadQQMedia }) {
    Object.assign(this, { scope, store, records, savedImages, messageImages, encoder, downloadPublic, downloadQQ });
    this.workspace = new StoredFiles(store, scope); this.memory = new MemoryFiles(store, scope);
  }
  async source(args, signal, use) {
    const access = row => assertMessageAccess(this.scope, this.store, row);
    await access(); signal?.throwIfAborted();
    if (args.text !== undefined) return use({ stream: [Buffer.from(args.text, 'utf8')], source: { kind: 'model_text' }, check: access });
    if (args.asset_id) {
      const asset = await this.savedImages.get(this.scope, args.asset_id);
      const { temporary, ...source } = asset.source;
      if (source.url) { const url = new URL(source.url); source.url = url.origin + url.pathname; }
      return use({ stream: [asset.bytes], source, label: asset.label, check: async () => { await access(); await this.savedImages.get(this.scope, args.asset_id, { metadataOnly: true }); } });
    }
    if (args.image_id) {
      const image = await this.messageImages.load(this.scope, args.image_id, access, { signal });
      return use({ stream: [image.bytes], source: { kind: image.source.kind, imageId: args.image_id, historical: image.source.historical }, check: image.assertAccess });
    }
    if (args.attachment_id) {
      const check = async () => {
        const row = await this.records.attachment(this.scope, args.attachment_id);
        if (!row) throw new Error('ATTACHMENT_NOT_RETAINED'); await access(row); return row;
      };
      const row = await check();
      return this.downloadQQ(row.url, 64 * 1024 * 1024, { signal, consume: stream => use({ stream,
        source: { kind: 'qq_attachment', attachmentId: args.attachment_id, historical: !!row.historical, mediaType: row.kind }, check }) });
    }
    const result = await this.downloadPublic(args.url, { types: /.*/, maxBytes: 64 * 1024 * 1024, signal,
      consume: (stream, metadata) => use({ stream, source: { kind: 'public_file', url: new URL(metadata.url).origin + new URL(metadata.url).pathname }, check: access }) });
    return result.value;
  }
  async save(args, { signal } = {}) {
    const type = fileType(args.name); this.workspace.name(args.name);
    if ([args.text !== undefined, !!args.url, !!args.asset_id, !!args.image_id, !!args.attachment_id].filter(Boolean).length !== 1) throw new Error('FILE_SOURCE_REQUIRED');
    const requested = args.format ?? 'auto';
    const format = requested === 'auto' ? type.extension === 'mp4' ? 'video' : 'original' : requested;
    if (args.area === 'memory') {
      if (args.text === undefined || format !== 'original') throw new Error('MEMORY_GENERATED_MARKDOWN_REQUIRED');
      signal?.throwIfAborted(); return this.memory.write(args.name, args.text, args.overwrite);
    }
    if (args.text !== undefined && type.kind !== 'text') throw new Error('FILE_TEXT_REQUIRED');
    if (args.bitrate_kbps !== undefined && !['video', 'audio'].includes(format)) throw new Error('FILE_ENCODING_OPTIONS_INVALID');
    if (format !== 'original' && type.extension !== ({ gif: 'gif', video: 'mp4', audio: 'mp3' }[format])) throw new Error('FILE_EXTENSION_MISMATCH');
    return this.source(args, signal, async source => {
      await source.check(); let temporary; let stream = source.stream; let duration;
      try {
        let preserveVideo = format === 'video' && source.source.kind === 'qq_attachment' && source.source.mediaType === 'video' && args.bitrate_kbps === undefined;
        if (preserveVideo) {
          const incoming = stream;
          const iterator = (async function* () { yield* incoming; })()[Symbol.asyncIterator]();
          const prefix = []; let size = 0;
          while (size < 12) { const next = await iterator.next(); if (next.done) break; prefix.push(Buffer.from(next.value)); size += next.value.length; }
          preserveVideo = Buffer.concat(prefix).toString('ascii', 4, 8) === 'ftyp';
          stream = (async function* () { try { yield* prefix; for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value; } } finally { await iterator.return?.(); } })();
        }
        if (format !== 'original' && !preserveVideo) {
          temporary = await mkdtemp(join(tmpdir(), 'watch-file-encode-'));
          const input = join(temporary, 'input');
          const incoming = stream;
          const bounded = async function* () {
            let size = 0;
            for await (const chunk of incoming) {
              signal?.throwIfAborted(); size += chunk.length;
              if (size > 64 * 1024 * 1024) throw new Error('FILE_SOURCE_TOO_LARGE');
              yield chunk;
            }
          };
          await writeAtomic(input, bounded(), { replace: false });
          await source.check();
          const encoded = await this.encoder.encode(input, { ...args, format, signal });
          stream = encoded.stream; duration = encoded.duration;
        }
        const checkSource = source.check;
        const checked = (async function* () { for await (const chunk of stream) { signal?.throwIfAborted(); yield chunk; } await checkSource(); })();
        const saved = await this.workspace.save(args.name, checked, { overwrite: args.overwrite, provenance: source.source, label: args.label || source.label || '', signal });
        return { ...saved, ...(duration === undefined ? {} : { duration }), format, preserved: preserveVideo || format === 'original' };
      } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    });
  }
  async read(name, area = 'workspace', startLine = 1, maxLines = 100) {
    if (area === 'memory') return [contentCodecs.value('json', await this.memory.read(name, startLine, maxLines))];
    if (area === 'assets') {
      const image = await this.savedImages.get(this.scope, name); const { bytes, ...metadata } = image;
      return [contentCodecs.value('json', { ...metadata, untrusted: true }), contentCodecs.value('file.bytes', bytes).to('image', { source: metadata.source })];
    }
    if (!['text', 'image'].includes(fileType(name).kind)) {
      const file = await this.workspace.descriptor(name); const { stream, close, assertAccess, ...metadata } = file;
      try { await assertAccess(); return [contentCodecs.value('json', { ...metadata, untrusted: true,
        guidance: file.kind === 'video' ? 'Metadata only. Use read_media(file_name,turn_id,...) for frames or optional speech.' : 'Metadata only. Binary bytes are not executed or interpreted.' })]; }
      finally { await close(); }
    }
    const file = await this.workspace.load(name); const { bytes, assertAccess, ...metadata } = file;
    if (file.kind === 'text') {
      const text = contentCodecs.value('file.bytes', bytes).to('text').single(); const lines = text.split(/\r?\n/);
      const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
      await assertAccess();
      return [contentCodecs.value('json', { ...metadata, start_line: startLine, total_lines: lines.length, content: selected.slice(0, 12000), truncated: selected.length > 12000 || startLine - 1 + maxLines < lines.length, untrusted: true })];
    }
    await assertAccess();
    return [contentCodecs.value('json', { ...metadata, untrusted: true }), contentCodecs.value('file.bytes', bytes).to('image', { source: file.source })];
  }
}
