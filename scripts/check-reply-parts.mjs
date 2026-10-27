// Offline: temporary assets and fake QQ transport; no models or network access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyParts } from '../lib/reply-parts.mjs';
import { ReplyBridge, callReplyBridge } from '../lib/reply-bridge.mjs';
import { resolveReplyMedia } from '../lib/reply-media.mjs';
import { Store } from '../lib/store.mjs';
import { SavedImages } from '../lib/saved-images.mjs';
import { QQDelivery } from '../lib/qq-delivery.mjs';

const id = 'a'.repeat(32);
const media = { type: 'image', asset_id: id };
const before = '  **before**\n'; const after = '\n_after_  ';
assert.deepEqual(replyParts(`${before}![sticker](asset://${id})${after}`), [{ text: before }, { text: '', media }, { text: after }]);
for (const url of ['https://not-in-download-allowlist.example/image(a).gif', '//example.com/picture.jpg']) {
  const remote = `![public](<${url}> "title")`;
  assert.deepEqual(replyParts(remote), [{ text: remote }]);
}
for (const text of [`\`![example](asset://${id})\``, `\\![escaped](asset://${id})`,
  `\`\`\`md\n![](asset://${id})\n\`\`\`\n`, `~~~\n![](asset://${id})\n~~~\n`, 'ordinary **Markdown**']) {
  assert.deepEqual(replyParts(text), [{ text }]);
}
assert.deepEqual(replyParts(`![a](/assets/${id})![b](attachment://audio/${id})`), [
  { text: '', media }, { text: '', media: { type: 'audio', attachment_id: id } },
]);
assert.deepEqual(replyParts(`![a](asset://${id} \"a (title)\")`), [{ text: '', media }]);
assert.deepEqual(replyParts('caption', media), [{ text: 'caption' }, { text: '', media }]);
for (const path of ['/tmp/private.png', 'file:///data/image.jpg', '../image.png', 'asset://missing']) {
  assert.throws(() => replyParts(`before ![local](${path}) after`), /REPLY_LOCAL_MEDIA_UNAVAILABLE/);
}

const root = await mkdtemp(join(tmpdir(), 'watch-reply-parts-'));
let bridge;
try {
  const scope = 'c2c:fixture'; const store = new Store(root); const savedImages = new SavedImages(store);
  const asset = await savedImages.save(scope, Buffer.from([255, 216, 255, 0]), {
    label: 'fixture', source: { kind: 'public_image', url: 'https://example.com/picture.jpg' }, shareable: true,
  });
  const submissions = []; let uploads = 0;
  const delivery = new QQDelivery({ markdown: true, onState() {}, assertCanContinue: async () => {}, notifyAdmins: async () => {},
    diagnostics: { call: operation => operation() },
    bot: { sendMarkdown: async (_target, text) => { submissions.push({ type: 'markdown', text }); },
      sendText: async () => { throw new Error('UNEXPECTED_PLAIN_TEXT'); },
      uploadMedia: async ({ srvSendMsg, buffer }) => { assert.equal(srvSendMsg, false); assert.equal(buffer.length, 4); uploads++; return { file_info: 'fixture' }; },
      send: async args => { assert.equal(args.msgType, 7); assert.equal(args.content, undefined); submissions.push({ type: 'media' }); } },
  });
  bridge = await ReplyBridge.open();
  const binding = bridge.bind({ id: randomUUID(), send: async (text, _target, spec, active) => {
    const resolved = spec ? await resolveReplyMedia(scope, spec, { store, savedImages }, active) : undefined;
    await delivery.send(scope, { text, media: resolved }, { isActive: active });
  } });
  const args = { turn_id: binding.turn.id, part_id: 1, text: `${before}![local](asset://${asset.asset_id})${after}` };
  const sent = await callReplyBridge(bridge.path, args);
  assert.equal(sent.messages_sent, 3); assert.equal(uploads, 1);
  assert.deepEqual(submissions, [{ type: 'markdown', text: before }, { type: 'media' }, { type: 'markdown', text: after }]);
  assert.deepEqual(await callReplyBridge(bridge.path, args), sent); assert.equal(submissions.length, 3);
  assert.equal((await callReplyBridge(bridge.path, { ...args, text: 'conflict' })).code, 'REPLY_PART_CONFLICT');
  const remote = '![](https://not-in-download-allowlist.example/image.gif)';
  await callReplyBridge(bridge.path, { ...args, part_id: 2, text: remote });
  assert.equal(submissions.at(-1).text, remote); assert.equal(uploads, 1);
  await binding.close();

  for (const failure of [new Error('REPLY_DELIVERY_UNKNOWN'), Object.assign(new Error('IMAGE_TOO_LARGE'), { replyNotSubmitted: true })]) {
    let calls = 0;
    const partial = bridge.bind({ id: randomUUID(), send: async () => { if (++calls === 2) throw failure; } });
    const args = { turn_id: partial.turn.id, part_id: 1, text: `before ![](asset://${id}) after` };
    assert.equal((await callReplyBridge(bridge.path, args)).code, failure.message);
    assert.equal(partial.turn.answerSent, 1); assert.equal(partial.turn.failed, true);
    await callReplyBridge(bridge.path, args); assert.equal(calls, 2);
    assert.equal((await callReplyBridge(bridge.path, { ...args, part_id: 2, text: 'no compensation' })).code, 'REPLY_TURN_EXPIRED');
    assert.equal(calls, 2); await partial.close();
  }
  console.log('Offline reply checks passed: ordered Markdown/media, client-side remote links, scoped assets, code literals, idempotency and partial-failure stop.');
} finally { await bridge?.close(); await rm(root, { recursive: true, force: true }); }
