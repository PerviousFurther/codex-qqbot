// Offline: synthetic image bytes, temporary state, fake HTTP/model/QQ transport.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import dns from 'node:dns/promises';
import https from 'node:https';
import { Store } from '../lib/store.mjs';
import { MAX_IMAGE_BYTES } from '../lib/image-policy.mjs';
import { downloadQQImage } from '../lib/qq-images.mjs';
import { SavedImages } from '../lib/saved-images.mjs';
import { MessageImages } from '../lib/message-images.mjs';
import { registerFileTools } from '../lib/tools/files.mjs';
import { toolFailure } from '../lib/tools/register.mjs';
import { resolveReplyMedia } from '../lib/reply-media.mjs';
import { ReplyBridge } from '../lib/reply-bridge.mjs';
import { VideoController } from '../lib/controller.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-image-limit-'));
const store = new Store(root); const scope = 'c2c:fixture';
const originalFetch = globalThis.fetch;
const image = size => { const bytes = Buffer.alloc(size); bytes.set([255, 216, 255]); return bytes; };
let payload = image(5 * 1024 * 1024); let header = true; let controller;
const savedImages = new SavedImages(store); const messageImages = new MessageImages(store);
try {
  globalThis.fetch = async () => new Response(payload, { headers: header ? { 'content-length': String(payload.length) } : {} });
  mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mock.method(https, 'get', (url, options, callback) => {
    const response = Readable.from([payload]); response.statusCode = 200; response.headers = { 'content-type': 'image/jpeg' };
    queueMicrotask(() => callback(response)); return new EventEmitter();
  }); syncBuiltinESMExports();
  const url = 'https://gchat.qpic.cn/fixture';
  assert.equal((await downloadQQImage(url)).bytes.length, payload.length);
  const [ref] = await messageImages.capture(scope, { kind: 'c2c', messageId: 'fixture', senderId: 'fixture', attachments: [{ url, content_type: 'image/jpeg' }] });
  const methods = new Map(); registerFileTools((name, description, schema, action) => methods.set(name, action), { scope, store, savedImages, messageImages });
  const blocks = await methods.get('save_file')({ name: 'fixture.jpg', url: 'https://github.com/image.jpg', label: 'Synthetic fixture' });
  const asset = blocks[0].single();
  assert.equal((await resolveReplyMedia(scope, { type: 'image', file_name: asset.name }, { store, savedImages }, () => true)).bytes.length, payload.length);
  const resolved = await resolveReplyMedia(scope, { type: 'image', url: 'https://github.com/image.jpg' }, { store, savedImages }, () => true);
  assert.equal(resolved.bytes.length, payload.length);
  payload = image(MAX_IMAGE_BYTES);
  assert.equal((await downloadQQImage(url)).bytes.length, MAX_IMAGE_BYTES);
  const exact = await savedImages.save(scope, payload, { source: { kind: 'public_image', url: 'https://github.com/image.jpg' } });
  assert.equal((await savedImages.get(scope, exact.asset_id)).bytes.length, MAX_IMAGE_BYTES);
  payload = image(MAX_IMAGE_BYTES + 1);
  for (header of [true, false]) await assert.rejects(downloadQQImage(url), /IMAGE_TOO_LARGE/);
  await assert.rejects(savedImages.save(scope, payload, { source: { kind: 'public_image' } }), /SAVED_IMAGE_TOO_LARGE/);
  await assert.rejects(methods.get('save_file')({ name: 'oversize.jpg', url: 'https://github.com/image.jpg', label: 'Too large' }), /IMAGE_TOO_LARGE/);
  await assert.rejects(resolveReplyMedia(scope, { type: 'image', url: 'https://github.com/image.jpg' }, { store, savedImages }, () => true), /IMAGE_TOO_LARGE/);
  const imageErrors = await messageImages.read(scope, [ref.id], async () => {});
  const info = imageErrors[0].single();
  assert.equal(info.error, 'IMAGE_TOO_LARGE'); assert.equal(info.limit_bytes, MAX_IMAGE_BYTES); assert(info.recovery.includes('压缩'));
  const failure = toolFailure(new Error('IMAGE_TOO_LARGE')).content[0].single();
  assert.equal(failure.limit_mib, 16); assert(failure.recovery.includes('明确告诉用户'));

  // Exercise the real controller/bridge path: local rejection precedes transport,
  // and a following text explanation remains available without retrying the image.
  const sent = []; let verified = false;
  const adapter = { reset: async () => {}, close: async () => {}, run: async options => {
    const bridge = new ReplyBridge(); const binding = bridge.bind({ id: 'fixture', send: options.onReply });
    const args = { turn_id: 'fixture', part_id: 1, kind: 'message', media: { type: 'image', asset_id: exact.asset_id } };
    await assert.rejects(bridge.dispatch(args), error => error.message === 'IMAGE_TOO_LARGE' && error.replyNotSubmitted === true);
    assert.equal(binding.turn.failed, false); assert.equal(sent.length, 0);
    await bridge.dispatch({ turn_id: 'fixture', part_id: 2, kind: 'message', text: '图片超过 16 MiB，请压缩后重发。' });
    verified = true; binding.close();
    return { sharedState: null, replyAnswerSent: 1 };
  } };
  controller = new VideoController({ adapter, store, admins: ['fixture'] });
  controller.savedImages = { get: async () => ({ bytes: payload, shareable: true }) };
  await controller.run(scope, 'fixture', {}, { onReply: async text => sent.push(text) });
  assert(verified); assert.deepEqual(sent, ['图片超过 16 MiB，请压缩后重发。']);
  const unsafe = new ReplyBridge(); const bound = unsafe.bind({ id: 'unsafe', send: async () => { throw new Error('IMAGE_TOO_LARGE'); } });
  await assert.rejects(unsafe.dispatch({ turn_id: 'unsafe', part_id: 1, kind: 'message', text: 'attempt' }), /IMAGE_TOO_LARGE/);
  assert.equal(bound.turn.failed, true); // An untagged error could be a real submission failure.
  await assert.rejects(unsafe.dispatch({ turn_id: 'unsafe', part_id: 2, kind: 'message', text: 'do not send' }), /REPLY_TURN_EXPIRED/);
  console.log('Offline image checks passed: 5/16 MiB acquisition/storage, oversize metadata, pre-submit explanation and uncertain-send stop policy.');
} finally {
  await controller?.close(); await messageImages.close();
  globalThis.fetch = originalFetch; mock.restoreAll(); syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
