import { ContentStream } from './content-stream.mjs';

// Explicit content conversions, usable at any program boundary. No I/O, routing,
// permissions or automatic conversion chains belong here.
export class ContentCodecs {
  #routes = new Map();
  register(from, to, convert) {
    if (!from || !to || typeof convert !== 'function') throw new Error('CONTENT_CODEC_INVALID');
    const key = `${from}\0${to}`;
    if (this.#routes.has(key)) throw new Error('CONTENT_CODEC_DUPLICATE');
    this.#routes.set(key, convert);
    return this;
  }
  stream(type, source) { return new ContentStream(type, source, this); }
  value(type, value) { return this.stream(type, [value]); }
  converter(from, to) {
    const convert = this.#routes.get(`${from}\0${to}`);
    if (!convert) throw new Error('CONTENT_CODEC_UNSUPPORTED');
    return convert;
  }
}

export const contentCodecs = new ContentCodecs()
  .register('json', 'text', value => JSON.stringify(value));
