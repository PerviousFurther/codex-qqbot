import { createHash } from 'node:crypto';

export const PRIVATE_REPLY = '这个请求无法在当前对话中处理。';
export function scopeId(scope) {
  return createHash('sha256').update(scope).digest('hex').slice(0, 32);
}

export function principal(message, admins = [], groups = []) {
  if (!message.senderId || !message.messageId) throw new Error('INVALID_MESSAGE');
  if (message.kind === 'c2c') return {
    scope: `c2c:${message.senderId}`, admin: admins.includes(message.senderId), private: true,
  };
  if (message.kind === 'group' && message.groupOpenid && groups.includes(message.groupOpenid)) {
    return { scope: `group:${message.groupOpenid}`, admin: false, private: false };
  }
  throw new Error('CONVERSATION_NOT_ALLOWED');
}

export function redactCredentials(text) {
  return text.replace(/((?:AppSecret|SESSDATA|bili_jct|access_token|refresh_token|OPENAI_API_KEY|QQBOT_APP_SECRET)["']?\s*[:=]\s*)["']?[^\s,"';}]+/gi, '$1[已隐藏]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[已隐藏令牌]')
    .replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, '[已隐藏密钥]');
}

export function publicReply(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  return redactCredentials(text).slice(0, 1800);
}
