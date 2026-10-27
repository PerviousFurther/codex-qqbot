import { z } from 'zod';
import { contentCodecs } from '../content-codecs.mjs';
import { callReplyBridge } from '../reply-bridge.mjs';
import { toolFailure } from './register.mjs';
import { replyToolInstructions } from '../reply-guidance.mjs';

export function registerReplyTools(register, socketPath) {
  register('send_reply', 'Send a considered chat message through this turn\'s authorized reply session. Never invent media URLs or IDs. Do not access adult websites or relay their links/media. Images are limited to 16 MiB and audio to 8 MiB. Temporary browser images use asset_id until turn end; explicitly saved image/audio uses file_name; older image assets remain readable through the file tools. Chat attachments, saved chat images/stickers and player screenshots stay in their source conversation; public images and webpage screenshots may go to authorized targets. Sending does not generate media or prove unseen/unheard content was inspected.\n' + replyToolInstructions, {
    target: z.string().max(80).default('current').describe('Current conversation by default; other recipients must use an id from replySession.targets.'),
    turn_id: z.string().uuid(), part_id: z.number().int().positive(), text: z.string().default(''),
    media: z.object({
      type: z.enum(['image', 'audio']),
      attachment_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
      asset_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
      file_name: z.string().min(1).max(180).optional(),
      url: z.string().url().max(2048).optional(),
    }).refine(value => [value.attachment_id, value.asset_id, value.url, value.file_name].filter(Boolean).length === 1
      && (!value.asset_id || value.type === 'image'), 'Exactly one media source is required; saved assets are images only').optional()
      .describe('Optional image/audio, sent as a separate rich-media message after text. Choose exactly one source: a current-conversation attachment_id, a retained image asset_id, an actually obtained public media url, or a saved workspace file_name. Backend URL downloads use the allowlist. Public assets may go to authorized targets; chat assets and player screenshots stay in their source conversation. Arbitrary filesystem paths are unsupported.'),
  }, async args => {
    const result = await callReplyBridge(socketPath, args);
    if (!result.ok) throw Object.assign(new Error(result.code), result.platform ?? {});
    return [contentCodecs.value('json', result)];
  }, error => toolFailure(error, error.message === 'QQ_RATE_LIMITED'
    ? 'QQ explicitly rejected this submission. Administrator notification was attempted separately. Do not retry or compensate with another message. Earlier parts of a multipart call may already have arrived. You may continue other work or send to another authorized target with the next part_id.'
    : 'Stop sending for this turn. Do not retry, replay earlier multipart messages, or compensate using another tool. A timeout may mean the message was delivered.'));
}
