import { constants, lstatSync } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redactCredentials } from './policy.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceFiles } from './workspace-files.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { writeAtomic } from './store.mjs';
import { contentCodecs } from './content-codecs.mjs';
import { fileType, fileEncoder } from './file-codecs.mjs';

// Immutable byte files plus a transactional publication index. Failed writes never
// replace a previous file; old flat UTF-8 workspace files remain readable in place.
export class StoredFiles extends WorkspaceFiles {
  async index(action) {
    const directory = await this.directory();
    const path = join(directory, '.files.sqlite');
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('FILE_INDEX_INVALID');
    const db = new DatabaseSync(path, { timeout: 2500, allowExtension: false });
    try {
      db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY,blob TEXT NOT NULL,metadata TEXT NOT NULL)');
      return action(db, directory);
    } finally { db.close(); }
  }
  async metadata(name) {
    this.name(name);
    const row = await this.index(db => db.prepare('SELECT * FROM files WHERE name=?').get(name));
    if (!row) return null;
    if (!/^[a-f0-9]{32}$/.test(row.blob)) throw new Error('FILE_METADATA_INVALID');
    const metadata = JSON.parse(row.metadata);
    if (metadata.name !== name || !/^[a-f0-9]{64}$/.test(metadata.sha256) || metadata.kind !== fileType(name).kind) throw new Error('FILE_METADATA_INVALID');
    return { ...metadata, blob: row.blob };
  }
  async save(name, source, { overwrite = false, provenance = { kind: 'model_text' }, label = '', signal } = {}) {
    this.name(name);
    return this.queue.run(async () => {
      const directory = await this.directory(); const legacy = join(directory, name);
      const previous = await this.metadata(name);
      const info = await lstat(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('WORKSPACE_REGULAR_FILE_REQUIRED');
      if ((previous || info) && !overwrite) throw new Error('WORKSPACE_FILE_EXISTS');
      const blob = randomBytes(16).toString('hex'); const path = join(directory, `.data-${blob}`);
      const digest = createHash('sha256'); let size; let published = false;
      const encoded = fileEncoder(name, source, { signal, onComplete: async count => {
        size = count; await assertMessageAccess(this.scope, this.store, provenance);
      } });
      async function* bytes() { for await (const chunk of encoded) { digest.update(chunk); yield chunk; } }
      try {
        await writeAtomic(path, bytes(), { replace: false });
        signal?.throwIfAborted(); await assertMessageAccess(this.scope, this.store, provenance);
        const metadata = { name, ...fileType(name), size, bytes: size, sha256: digest.digest('hex'), source: provenance,
          label: redactCredentials(String(label)).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120), savedAt: new Date().toISOString() };
        let old;
        await this.index((db, current) => {
          if (current !== directory) throw new Error('WORKSPACE_DIRECTORY_INVALID');
          if (!lstatSync(path).isFile()) throw new Error('FILE_CHANGED');
          db.exec('BEGIN IMMEDIATE');
          try {
            old = db.prepare('SELECT blob FROM files WHERE name=?').get(name);
            if (old && !overwrite) throw new Error('WORKSPACE_FILE_EXISTS');
            db.prepare('INSERT INTO files VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blob=excluded.blob,metadata=excluded.metadata')
              .run(name, blob, JSON.stringify(metadata));
            db.exec('COMMIT'); published = true;
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        });
        if (old) await unlink(join(directory, `.data-${old.blob}`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (info) await unlink(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
        return metadata;
      } finally { if (!published) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
  async descriptor(name) {
    this.name(name); const directory = await this.directory(); const type = fileType(name);
    const stored = await this.metadata(name);
    const path = join(directory, stored ? `.data-${stored.blob}` : name);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (await realpath(`/proc/self/fd/${file.fd}`) !== path) throw new Error('WORKSPACE_DIRECTORY_INVALID');
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('WORKSPACE_REGULAR_FILE_REQUIRED');
      if (info.size > type.maxBytes) throw new Error('FILE_TOO_LARGE');
      if (!stored && type.kind !== 'text') throw new Error('FILE_METADATA_MISSING');
      const { blob, ...metadata } = stored ?? { name, ...type, size: info.size, bytes: info.size, source: { kind: 'model_text' } };
      const assertAccess = async () => {
        await assertMessageAccess(this.scope, this.store, metadata.source);
        const current = await lstat(path);
        if (!current.isFile() || current.isSymbolicLink() || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error('FILE_CHANGED');
        if (stored && (await this.metadata(name))?.blob !== blob) throw new Error('FILE_CHANGED');
      };
      await assertAccess();
      return { ...metadata, assertAccess, close: () => file.close(), stream: () => fileEncoder(name,
        file.createReadStream({ autoClose: false }), { onComplete: async () => { await assertAccess(); } }) };
    } catch (error) { await file.close(); throw error; }
  }
  async load(name) {
    const file = await this.descriptor(name); const { stream, close, ...metadata } = file;
    const chunks = []; const hash = createHash('sha256');
    try {
      for await (const chunk of stream()) { chunks.push(chunk); hash.update(chunk); }
      const sha256 = hash.digest('hex');
      if (file.sha256 && sha256 !== file.sha256) throw new Error('FILE_CHANGED');
      return { ...metadata, sha256, bytes: Buffer.concat(chunks) };
    } finally { await close(); }
  }
  async list() {
    const entries = await super.entries(await this.directory());
    const stored = await this.index(db => db.prepare('SELECT metadata FROM files ORDER BY name').all().map(row => JSON.parse(row.metadata)));
    const map = new Map(entries.map(file => [file.name, { ...file, ...fileType(file.name) }]));
    for (const file of stored) {
      await assertMessageAccess(this.scope, this.store, file.source);
      map.set(file.name, file);
    }
    await assertMessageAccess(this.scope, this.store);
    return { files: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)), untrusted: true };
  }
  async removeFile(name, expectedDigest) {
    return this.queue.run(async () => {
      const file = await this.load(name);
      if (file.sha256 !== expectedDigest) throw new Error('WORKSPACE_FILE_CHANGED');
      await file.assertAccess();
      let blob;
      const directory = await this.directory();
      await this.index(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare('SELECT * FROM files WHERE name=?').get(name);
          if (row && JSON.parse(row.metadata).sha256 !== expectedDigest) throw new Error('WORKSPACE_FILE_CHANGED');
          blob = row?.blob; db.prepare('DELETE FROM files WHERE name=?').run(name); db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      await unlink(join(directory, blob ? `.data-${blob}` : name));
      return { deleted: true };
    });
  }
  async readText(name) {
    if (fileType(name).kind !== 'text') throw new Error('FILE_TEXT_REQUIRED');
    return contentCodecs.value('file.bytes', (await this.load(name)).bytes).to('text').single();
  }
  async remove(name, expectedContent) {
    const file = await this.load(name);
    if (contentCodecs.value('file.bytes', file.bytes).to('text').single() !== expectedContent) throw new Error('WORKSPACE_FILE_CHANGED');
    return this.removeFile(name, file.sha256);
  }
  write(name, text, overwrite = false) { return this.save(name, [Buffer.from(text)], { overwrite }); }
}
