import { join } from 'node:path';
import { SerialQueue } from './serial-queue.mjs';
import { redactCredentials } from './policy.mjs';

export const sharedStateSchema = {
  type: 'object', additionalProperties: false,
  properties: { mood: { type: 'string', maxLength: 80 }, focus: { type: 'string', maxLength: 160 } },
  required: ['mood', 'focus'],
};
export function validSharedState(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.mood === 'string' && [...value.mood].length <= 80
    && typeof value.focus === 'string' && [...value.focus].length <= 160
    && Object.keys(value).every(key => key === 'mood' || key === 'focus');
}

// Only the main service writes this small snapshot; MCP processes never own it.
export class SharedState {
  constructor(store) { this.store = store; this.queue = new SerialQueue(); this.path = join(store.root, 'shared-state.json'); }
  async read() {
    const value = await this.store.read(this.path, { revision: 0, updatedAt: null, state: { mood: '', focus: '' } });
    if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !validSharedState(value.state)) throw new Error('SHARED_STATE_INVALID');
    return value;
  }
  update(revision, state, isActive) {
    return this.queue.run(async () => {
      if (!isActive()) return;
      if (!validSharedState(state)) throw new Error('SHARED_STATE_INVALID');
      const current = await this.read();
      // A turn based on an older snapshot must not replace a newer turn's state.
      if (!isActive() || current.revision !== revision) return;
      const next = { mood: redactCredentials(state.mood).trim(), focus: redactCredentials(state.focus).trim() };
      if (current.state.mood === next.mood && current.state.focus === next.focus) return;
      await this.store.write(this.path, { revision: revision + 1, updatedAt: new Date().toISOString(), state: next });
    });
  }
}
