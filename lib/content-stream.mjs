// A typed sequence of complete content units, not necessarily byte chunks.
// Sources own access and lifetime; iteration is lazy and does not buffer history.
export class ContentStream {
  constructor(type, source, codecs) {
    if (typeof type !== 'string' || !type ||
      !(typeof source?.[Symbol.iterator] === 'function' || typeof source?.[Symbol.asyncIterator] === 'function')) {
      throw new Error('CONTENT_STREAM_INVALID');
    }
    this.type = type;
    this.source = source;
    this.codecs = codecs;
  }
  // Stream transforms may split/combine units; implement them as lazy generators.
  through(type, transform) {
    return new ContentStream(type, transform(this), this.codecs);
  }
  to(type, context) {
    const convert = this.codecs.converter(this.type, type);
    const upstream = this;
    const source = {
      async *[Symbol.asyncIterator]() {
        for await (const value of upstream) yield await convert(value, context);
      },
    };
    if (typeof this.source[Symbol.iterator] === 'function') {
      source[Symbol.iterator] = function* () {
        for (const value of upstream) {
          const result = convert(value, context);
          if (typeof result?.then === 'function') {
            // Avoid an unhandled rejection when a caller selects sync iteration.
            Promise.resolve(result).catch(() => {});
            throw new Error('CONTENT_STREAM_ASYNC_REQUIRED');
          }
          yield result;
        }
      };
    }
    return this.through(type, () => source);
  }
  *[Symbol.iterator]() {
    if (typeof this.source[Symbol.iterator] !== 'function') throw new Error('CONTENT_STREAM_ASYNC_REQUIRED');
    yield* this.source;
  }
  async *[Symbol.asyncIterator]() { yield* this.source; }
  single() {
    const iterator = this[Symbol.iterator]();
    try {
      const first = iterator.next();
      if (first.done || !iterator.next().done) throw new Error('CONTENT_STREAM_EXPECTED_SINGLE');
      return first.value;
    } finally { iterator.return?.(); }
  }
  async collect() {
    const values = [];
    for await (const value of this) values.push(value);
    return values;
  }
}
