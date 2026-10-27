import { watchMediaTurn } from './media-turn.mjs';

// Browser pixels are working resources, not selected persistent files.
export class TurnImages {
  constructor({ savedImages, eventSocket, watch = watchMediaTurn }) {
    Object.assign(this, { savedImages, eventSocket, watch }); this.turns = new Map();
  }
  async ensure(scope, turnId) {
    if (this.closed || !turnId || !this.eventSocket) throw new Error('IMAGE_TURN_REQUIRED');
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { scope, ids: new Set(), pending: new Set() }; this.turns.set(turnId, turn);
      turn.subscription = this.watch(this.eventSocket, turnId, () => this.clear(turnId, turn));
    }
    const subscription = await turn.subscription; await subscription.check(); subscription.assertActive();
    if (turn.cleaning || this.closed) throw new Error('IMAGE_TURN_REQUIRED');
    return { turn, subscription };
  }
  async save(scope, bytes, { turnId, ...options }) {
    const { turn, subscription } = await this.ensure(scope, turnId);
    const work = Promise.resolve().then(async () => {
      const asset = await this.savedImages.save(scope, bytes, { ...options, source: { ...options.source, temporary: true } });
      turn.ids.add(asset.asset_id);
      await subscription.check(); subscription.assertActive();
      if (turn.cleaning || this.closed) throw new Error('IMAGE_TURN_REQUIRED');
      return { ...asset, temporary: true };
    });
    turn.pending.add(work);
    try { return await work; } finally { turn.pending.delete(work); }
  }
  async clear(id, turn) {
    if (turn.cleaning) return turn.cleaning;
    turn.cleaning = (async () => {
      await Promise.allSettled([...turn.pending]);
      for (const assetId of turn.ids) await this.savedImages.discard(turn.scope, assetId);
      this.turns.delete(id);
    })();
    return turn.cleaning;
  }
  async close() {
    this.closed = true;
    for (const [id, turn] of this.turns) {
      await this.clear(id, turn);
      await (await turn.subscription.catch(() => null))?.close();
    }
  }
}
