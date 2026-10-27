import { SerialQueue } from './serial-queue.mjs';

// Preserve output ordering without imposing local rate limits or retrying sends.
export class ProactiveQueue {
  constructor() { this.queue = new SerialQueue(); }
  run(_target, operation) { return this.queue.run(operation); }
}
