import { hasMessageParts } from './message-records.mjs';

// The same classification applies before group collection and command dispatch.
export const commandText = value => value === '切换模型' ? '/models' : value;
export const isCommandText = value => commandText(value?.trim() ?? '').startsWith('/');
export function messageText(message) {
  return commandText(message.content?.trim() || (hasMessageParts(message)
    ? '［本条QQ消息没有文字正文，已投递的内容见消息结构。］' : ''));
}
