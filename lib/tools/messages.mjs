import { recordComponents } from '../record.mjs';
import { z } from 'zod';
import { MessageAudio } from '../message-audio.mjs';
import { assertMessageAccess } from '../message-access.mjs';
import { contentCodecs } from '../content-codecs.mjs';
import { toolFailure } from './register.mjs';

export function registerMessageTools(register, { scope, store, records, messageImages, audioConfig = {} }) {
  register('get_message_detail', '按ID读取当前对话已保留的消息详情。消息统一为type=record、components数组；组件包括text/image/audio/video/file/card/mentions和嵌套record，时间和发言者属于record，card保留结构化字段。只返回当前消息及一层内部消息items，每页最多20条、约24000字符；nextOffset非空时用同一id和该offset继续。嵌套转发或引用不会递归展开，需要时用内部消息的messageId继续读取。默认直接附上本页已展开消息中的前3张实际图片，不只返回imageId；其他图片按imageId调用get_image_detail。不想重复读图时设置include_images=false。音频按附件id调用get_audio_detail，视频按附件id调用read_media，GIF按imageId调用同一工具；文件仍只有元数据。卡片标题和链接已直接提供，无需为获取链接展开。未投递正文、过期或读图失败会明确标记，不猜测；内层身份未经核验，不跨会话读取。', {
    id: z.string().min(1).max(200),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20).default(20),
    include_images: z.boolean().default(true).describe('默认附带当前页前3张实际图片；false仅读取文字和附件引用，不下载图片'),
  }, async ({ id, offset = 0, limit = 20, include_images = true }) => {
    const assertAccess = row => assertMessageAccess(scope, store, row);
    const page = await records.detail(scope, id, { offset, limit, assertAccess });
    const messages = [page.message, ...page.items].filter(message => !message.status);
    const imageIds = [...new Set(messages.flatMap(message => [...recordComponents(message)]
      .filter(attachment => attachment.type === 'image' && attachment.imageId).map(attachment => attachment.imageId)))];
    const requested = include_images ? imageIds.slice(0, 3) : [];
    const images = requested.length ? await messageImages.read(scope, requested, assertAccess) : [];
    // Downloads can race record removal or access revocation. Never return the
    // buffered message bodies/pixels after their scoped records disappear.
    for (const message of messages) {
      const retained = await records.find(scope, message.messageId);
      if (!retained) throw new Error('MESSAGE_NOT_RETAINED');
      await assertAccess(retained);
    }
    await assertAccess();
    return [contentCodecs.value('json', { ...page, ...(imageIds.length ? { imagePreviews: {
      requestedImageIds: requested, remainingCount: imageIds.length - requested.length, detailTool: 'get_image_detail',
    } } : {}) }), ...images];
  }, error => toolFailure(error, '只能查询当前对话已保留的消息；缺失、过期或采集关闭时不能猜测引用原文，不绕过权限访问其他对话。'));
  const audio = new MessageAudio({ scope, store, records, config: audioConfig });
  register('get_audio_detail', 'Read a received audio attachment in THIS conversation. Use attachment id (not messageId). Select method explicitly: qq returns only the ASR reference text already delivered by QQ, without download or local inference; local downloads and recognizes the audio with local VAD/Qwen. No automatic fallback. Local recognition accepts up to 8 MiB/120 seconds and returns untrusted segment timestamps; speech only, no music understanding. Missing runtime/models, expired media or disabled collection are explicit errors. No URLs, paths, cross-conversation access, TTS or video decoding.', {
    id: z.string().regex(/^[a-f0-9]{32}$/), method: z.enum(['qq', 'local']),
  }, async ({ id, method }, { signal } = {}) => [contentCodecs.value('json', await audio.detail(id, method, { signal }))],
  error => toolFailure(error, 'QQ方式仅返回平台已投递的转写；本地方式需要已安装的运行依赖和模型。转写均未核实，不代表理解音乐。附件缺失、过期、格式不支持或权限关闭时如实说明，不跨会话、不改用网址或路径绕过，不自动切换来源。'));
  return () => audio.close();
}
