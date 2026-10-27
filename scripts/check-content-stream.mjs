// Offline stream contract checks; no service, network or persisted chat state.
import assert from 'node:assert/strict';
import { ContentCodecs } from '../lib/content-codecs.mjs';
import { ContentStream } from '../lib/content-stream.mjs';

const codecs = new ContentCodecs()
  .register('bytes', 'text', bytes => bytes.toString('utf8'))
  .register('text', 'record', (text, { prefix }) => ({ text: prefix + text }))
  .register('record', 'async.record', async value => value);
const decode = source => codecs.stream('bytes', source).to('text').to('record', { prefix: 'decoded:' });
let pulls = 0, closed = 0;
function* fileSource() {
  try {
    for (const value of ['one', 'two']) { pulls++; yield Buffer.from(value); }
  } finally { closed++; }
}
const flow = decode(fileSource());
assert.equal(flow.type, 'record');
assert.equal(pulls, 0); // Attaching codecs does not acquire or convert contents.
for (const value of flow) {
  assert.deepEqual(value, { text: 'decoded:one' });
  break;
}
assert.equal(pulls, 1);
assert.equal(closed, 1); // Early consumer exit reaches the source.

// A different, asynchronous origin uses exactly the same decoder pipeline.
let pending = 0, peak = 0, asyncClosed = false;
async function* programSource() {
  try {
    for (const value of ['one', 'two']) {
      pending++; peak = Math.max(peak, pending);
      yield Buffer.from(value);
      pending--;
    }
  } finally { asyncClosed = true; }
}
assert.deepEqual(await decode(programSource()).to('async.record').collect(), [
  { text: 'decoded:one' }, { text: 'decoded:two' },
]);
assert.equal(peak, 1); // No concurrent prefetch or conversion reordering.
assert(asyncClosed);
assert.deepEqual([...decode([Buffer.from('one')])], [{ text: 'decoded:one' }]);
assert.deepEqual(await codecs.stream('bytes', []).to('text').collect(), []);
assert.throws(() => codecs.value('record', {}).to('async.record').single(), /ASYNC_REQUIRED/);
assert.throws(() => decode(programSource()).single(), /ASYNC_REQUIRED/);
assert.throws(() => codecs.stream('bytes', []).single(), /EXPECTED_SINGLE/);
assert.throws(() => codecs.stream('bytes', [1, 2]).single(), /EXPECTED_SINGLE/);
assert.throws(() => new ContentStream('bytes', null, codecs), /STREAM_INVALID/);
assert.throws(() => codecs.value('bytes', Buffer.alloc(0)).to('missing'), /UNSUPPORTED/);

// Stream stages can change unit boundaries instead of forcing one-to-one maps.
function* words(input) {
  for (const text of input) yield* text.split(' ');
}
assert.deepEqual([...codecs.stream('bytes', [Buffer.from('one two'), Buffer.from('three')])
  .to('text').through('text', words).to('record', { prefix: '' })], [
  { text: 'one' }, { text: 'two' }, { text: 'three' },
]);
async function* join(input) {
  let text = '';
  for await (const value of input) text += value;
  yield text;
}
assert.deepEqual(await codecs.stream('bytes', programSource()).to('text').through('text', join).collect(), ['onetwo']);

// Converter failures close the source in both iteration modes.
codecs.register('bytes', 'failure', () => { throw new Error('FIXTURE_FAILURE'); });
closed = 0;
assert.throws(() => [...codecs.stream('bytes', fileSource()).to('failure')], /FIXTURE_FAILURE/);
assert.equal(closed, 1);
asyncClosed = false;
await assert.rejects(codecs.stream('bytes', programSource()).to('failure').collect(), /FIXTURE_FAILURE/);
assert(asyncClosed);
asyncClosed = false;
for await (const _ of decode(programSource()).to('async.record')) break;
assert(asyncClosed);
codecs.register('record', 'rejected', async () => { throw new Error('FIXTURE_REJECTION'); });
await assert.rejects(decode(programSource()).to('rejected').collect(), /FIXTURE_REJECTION/);

console.log('Content streams: offline contract checks passed.');
