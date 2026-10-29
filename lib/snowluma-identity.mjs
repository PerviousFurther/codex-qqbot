export function qqId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{4,15}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('SNOWLUMA_ID_INVALID');
  return text;
}
// '~' was never legal in an official OpenID. Include the logged-in account so
// another account's events cannot inherit the same user's scopes or grants.
export function snowIdentity(account, value) { return `sl~${qqId(account)}~${qqId(value)}`; }
export function snowRecipient(account, identity) {
  const prefix = `sl~${qqId(account)}~`;
  if (typeof identity !== 'string' || !identity.startsWith(prefix)) throw new Error('SNOWLUMA_TARGET_MISMATCH');
  return Number(qqId(identity.slice(prefix.length)));
}
export function snowMessageId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^-?\d{1,20}$/.test(id)) throw new Error('SNOWLUMA_MESSAGE_ID_INVALID');
  return `slmsg~${id}`;
}
