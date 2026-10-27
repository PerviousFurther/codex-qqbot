// Return each operation's real result; one rejection never poisons later work.
export class SerialQueue {
  constructor() { this.idle = Promise.resolve(); }
  run(operation) {
    const result = this.idle.then(operation);
    this.idle = result.then(() => {}, () => {});
    return result;
  }
}
