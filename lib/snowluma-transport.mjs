import { AsyncLocalStorage } from 'node:async_hooks';
import { SnowLumaHttpClient, SnowLumaApiError, SnowLumaError, message } from '@snowluma/sdk';
import { snowRecipient, qqId } from './snowluma-identity.mjs';
import { redactCredentials } from './policy.mjs';
import { validateControls } from './interaction.mjs';
import { imageType, MAX_IMAGE_BYTES } from './image-policy.mjs';
import { audioType } from './audio-policy.mjs';

export function snowEndpoint(value, protocol) {
  let url; try { url = new URL(value); } catch { throw new Error('SNOWLUMA_ENDPOINT_INVALID'); }
  if (url.protocol !== protocol || !['127.0.0.1', 'localhost', 'snowluma'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('SNOWLUMA_ENDPOINT_INVALID');
  return url.href;
}
const submissions = new Set(['send_private_msg', 'send_group_msg', 'upload_private_file', 'upload_group_file']);

// SDK owns framing/streamed upload. The guarded fetch runs after SDK preparation,
// immediately before each HTTP request, with no redirect or automatic send retry.
export class SnowLumaTransport {
  constructor({ account, url, token, fetch: fetchImpl = globalThis.fetch }) {
    this.account = qqId(account);
    if (typeof token !== 'string' || !token.trim()) throw new Error('SNOWLUMA_TOKEN_REQUIRED');
    this.current = new AsyncLocalStorage();
    this.client = new SnowLumaHttpClient({ baseUrl: snowEndpoint(url, 'http:'), accessToken: token, requestTimeoutMs: 30000,
      fetch: async (endpoint, init) => {
        const guards = this.current.getStore();
        if (!guards) throw new Error('SNOWLUMA_SEND_GUARD_REQUIRED');
        const action = JSON.parse(init.body).action;
        if (action !== 'upload_file_stream' && !submissions.has(action)) throw new Error('SNOWLUMA_ACTION_UNSUPPORTED');
        try { await guards.beforeCommit(); } catch (error) { guards.failure = error; throw error; }
        if (submissions.has(action)) guards.onDispatch();
        const response = await fetchImpl(endpoint, { ...init, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          guards.failure = new Error(response.status === 429 ? 'QQ_RATE_LIMITED' : 'SNOWLUMA_HTTP_REJECTED');
          throw guards.failure;
        }
        return response;
      } });
  }
  async send(target, { text = '', media, file, buttons }, guards) {
    const recipient = snowRecipient(this.account, target.targetId);
    const group = target.scope === 'group';
    if (!['group', 'c2c'].includes(target.scope)) throw new Error('CONVERSATION_NOT_ALLOWED');
    const context = { ...guards, failure: null };
    return this.current.run(context, async () => {
      try {
        const body = [];
        if (buttons) {
          validateControls(buttons);
          text += '\n' + buttons.rows.flat().map(item => `${item.label}：${item.command}`).join('\n');
        }
        if (text) body.push(message.text(redactCredentials(text)));
        if (media || file) {
          let bytes, filename;
          if (file) {
            if (!/^[a-zA-Z0-9_.-]{1,120}\.txt$/.test(file.name) || typeof file.text !== 'string'
              || Buffer.byteLength(file.text) > 512 * 1024 || group) throw new Error('INVALID_DIAGNOSTIC_FILE');
            bytes = Buffer.from(file.text, 'utf8'); filename = file.name;
          } else {
            if (!Buffer.isBuffer(media.bytes)) throw new Error('REPLY_MEDIA_UNAVAILABLE');
            bytes = media.bytes;
            const limit = media.type === 'image' ? MAX_IMAGE_BYTES : media.type === 'audio' ? 8 * 1024 * 1024 : 64 * 1024 * 1024;
            if (bytes.length > limit) throw new Error(media.type === 'image' ? 'IMAGE_TOO_LARGE' : 'REPLY_MEDIA_TOO_LARGE');
            if (media.type === 'image') filename = `image.${imageType(bytes).split('/')[1].replace('jpeg', 'jpg')}`;
            else if (media.type === 'audio') filename = `audio.${({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' })[audioType(bytes)] ?? audioType(bytes).split('/')[1]}`;
            else if (media.type === 'video') filename = 'video.mp4';
            else throw new Error('REPLY_MEDIA_UNSUPPORTED');
          }
          guards.onStage(file ? 'diagnostic_file_upload' : 'MEDIA_UPLOAD');
          const upload = await this.client.uploadFileStream(bytes, { filename, fileRetention: 600000,
            onProgress: () => guards.beforeCommit() });
          if (typeof upload.file_path !== 'string' || !upload.file_path) throw new Error('SNOWLUMA_UPLOAD_INVALID');
          // An upload ACK carries a server-local path. Only this trusted ACK may
          // supply it; user/model paths are never used as server file input.
          await guards.beforeCommit();
          guards.onStage(file ? 'diagnostic_file_send' : 'MEDIA_SEND');
          if (file) {
            // File publication is one substantive submission; its caption is not
            // separately sent, so a failed file never replays a prior caption.
            const result = await this.client.uploadPrivateFile(recipient, upload.file_path, { name: filename, uploadFile: false });
            return { accepted: true, ...result };
          }
          body.push(({ image: message.image, audio: message.record, video: message.video })[media.type](upload.file_path));
        }
        await guards.beforeCommit();
        const result = group ? await this.client.sendGroupMessage(recipient, body) : await this.client.sendPrivateMessage(recipient, body);
        return { ...result, ...(result?.message_id != null ? { id: String(result.message_id) } : {}) };
      } catch (error) {
        if (context.failure) throw context.failure;
        if (error instanceof SnowLumaApiError) throw Object.assign(new Error(error.retcode === 429 ? 'QQ_RATE_LIMITED' : 'SNOWLUMA_API_REJECTED'), { bizCode: error.retcode });
        // SDK transport errors can contain endpoint/token details in their causes.
        if (error instanceof SnowLumaError) throw new Error('SNOWLUMA_TRANSPORT_FAILED');
        throw error;
      }
    });
  }
}
