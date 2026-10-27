import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

export const personaTokenLimit = 500;
let encoding;
// A stable local quota, independent of the selected conversation model or network availability.
export function personaTokens(text) {
  encoding ??= new Tiktoken(o200kBase);
  return encoding.encode(text, [], []).length;
}
