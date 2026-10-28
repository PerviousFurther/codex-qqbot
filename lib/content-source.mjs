import { createHash } from 'node:crypto';
import { validatePublicURL } from './public-resource.mjs';

export const contentRecordName = /^(?:[a-f0-9]{32}|BV[a-zA-Z0-9]{10})\.json$/;
export function contentSource(value) {
  const url = validatePublicURL(value);
  if ([...url.searchParams.keys()].some(key => /token|secret|password|credential|session|signature|^auth$|^key$/i.test(key))) throw new Error('CONTENT_PRIVATE_URL');
  return { id: createHash('sha256').update(url.href).digest('hex').slice(0, 32), url: url.href };
}
// Stored records from the former video subsystem remain readable without rewriting.
export function readContentRecord(record) {
  if (!record) return null;
  return record.url ? record : { ...record, id: record.bvid,
    url: `https://www.bilibili.com/video/${record.bvid}/`, kind: 'video' };
}
