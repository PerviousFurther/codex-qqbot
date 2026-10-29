import { redactCredentials } from './policy.mjs';
import { normalizeQQText } from './message-elements.mjs';

// Public catalog metadata only; never forward SDK URLs or arbitrary fields.
export class SnowLumaFaces {
  constructor(channel) { this.channel = channel; }
  async search(query, checkAccess, signal) {
    if (typeof query !== 'string' || !query.trim() || query.length > 80) throw new Error('CONTEXT_QUERY_INVALID');
    const c = this.channel, generation = c.generation;
    const check = async () => {
      if (signal?.aborted) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
      if (!c.ready || !c.accepting || c.stopped || generation !== c.generation) throw new Error('SNOWLUMA_CONNECTION_UNAVAILABLE');
      await checkAccess();
      if (signal?.aborted || generation !== c.generation || !c.ready || !c.accepting || c.stopped) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
    };
    await check();
    let faces;
    try {
      const options = { signal, timeoutMs: 10000 };
      if (/^\d{1,10}$/.test(query)) {
        const face = await c.client.fetchFaceEntity(Number(query), options);
        faces = face ? [face] : [];
      } else faces = (await c.client.searchSysFaces(query.trim(), options))?.faces;
    } catch { await check(); throw new Error('FACE_LOOKUP_FAILED'); }
    await check();
    if (!Array.isArray(faces)) throw new Error('FACE_LOOKUP_FAILED');
    const clean = value => typeof value === 'string' ? redactCredentials(normalizeQQText(value)).slice(0, 80) : '';
    const valid = faces.filter(face => /^\d{1,10}$/.test(face?.q_sid ?? '') && typeof face.q_des === 'string');
    const items = valid.slice(0, 20).map(face => ({ emoji_id: String(face.q_sid), name: clean(face.q_des),
      aliases: (Array.isArray(face.emoji_name_alias) ? face.emoji_name_alias : []).filter(v => typeof v === 'string').slice(0, 8).map(clean) }));
    await check();
    return { items, truncated: valid.length > 20, untrusted: true,
      limitation: 'QQ system-face names and IDs, not viewed pixels or guaranteed reaction support. Choose a returned emoji_id; refine the query if needed. No match means unknown, never guess a mapping.' };
  }
}
