import { audioType } from './audio-policy.mjs';
import { MAX_IMAGE_BYTES, imageType } from './image-policy.mjs';
import { downloadQQMedia } from './qq-images.mjs';
import { downloadPublicResource } from './public-resource.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { StoredFiles } from './stored-files.mjs';

export async function resolveReplyMedia(scope, spec, { store, messageRecords, savedImages }, isActive, { crossConversation = false } = {}) {
  if (!spec || !['image', 'audio'].includes(spec.type)
    || [spec.attachment_id, spec.asset_id, spec.url, spec.file_name].filter(Boolean).length !== 1
    || spec.asset_id && spec.type !== 'image') throw new Error('REPLY_MEDIA_INVALID');
  const assertActive = () => { if (!isActive()) throw new Error('REPLY_TURN_EXPIRED'); };
  let assertAccess = async () => { assertActive(); };
  let bytes;
  const maxBytes = spec.type === 'image' ? MAX_IMAGE_BYTES : 8 * 1024 * 1024;
  if (spec.file_name) {
    const file = await new StoredFiles(store, scope).load(spec.file_name);
    if (file.kind !== spec.type) throw new Error('ATTACHMENT_TYPE_MISMATCH');
    assertAccess = async () => {
      assertActive(); await file.assertAccess();
      if (crossConversation && !['public_file', 'public_image', 'webpage_screenshot'].includes(file.source.kind)) throw new Error('CROSS_CONVERSATION_ASSET_DISABLED');
    };
    bytes = file.bytes;
  } else if (spec.asset_id) {
    assertAccess = async () => {
      assertActive();
      const asset = await savedImages.get(scope, spec.asset_id, { metadataOnly: true });
      if (crossConversation && !asset.shareable) throw new Error('CROSS_CONVERSATION_ASSET_DISABLED');
    };
    await assertAccess();
    bytes = (await savedImages.get(scope, spec.asset_id)).bytes;
  } else if (spec.attachment_id) {
    assertAccess = async () => {
      assertActive();
      const row = await messageRecords.attachment(scope, spec.attachment_id);
      if (!row) throw new Error('ATTACHMENT_NOT_RETAINED');
      await assertMessageAccess(scope, store, row);
      if (row.kind !== spec.type) throw new Error('ATTACHMENT_TYPE_MISMATCH');
    };
    await assertAccess();
    const row = await messageRecords.attachment(scope, spec.attachment_id);
    if (!row) throw new Error('ATTACHMENT_NOT_RETAINED');
    try { bytes = await downloadQQMedia(row.url, maxBytes); }
    catch (error) {
      if (spec.type === 'audio' && error.message === 'IMAGE_TOO_LARGE') throw new Error('AUDIO_TOO_LARGE');
      throw error;
    }
  } else {
    assertActive();
    let result;
    try { result = await downloadPublicResource(spec.url, {
      types: spec.type === 'image' ? /^(image\/|application\/octet-stream(?:;|$))/i : /^(audio\/|application\/(?:octet-stream|ogg)(?:;|$))/i,
      maxBytes,
    }); } catch (error) {
      if (error.message === 'WEB_PAGE_TOO_LARGE') throw new Error(spec.type === 'image' ? 'IMAGE_TOO_LARGE' : 'AUDIO_TOO_LARGE');
      throw error;
    }
    bytes = result.bytes;
  }
  if (bytes.length > maxBytes) throw new Error(spec.type === 'image' ? 'IMAGE_TOO_LARGE' : 'AUDIO_TOO_LARGE');
  const mimeType = spec.type === 'image' ? imageType(bytes) : audioType(bytes);
  await assertAccess();
  return { type: spec.type, bytes, mimeType, assertAccess };
}
