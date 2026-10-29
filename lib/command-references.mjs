import { join } from 'node:path';
import { SerialQueue } from './serial-queue.mjs';
import { validateControls } from './interaction.mjs';

// Only declared object positions are translated; free-form user values stay literal.
function slots(words) {
  const result = [];
  const add = (index, domain, group = false, confirmation = false) => result.push({ index, domain, group, confirmation });
  const root = words[0];
  if (root === '/group') add(2, () => 'group', true);
  if (['/group-model', '/group-models', '/group-thinking', '/group-memory'].includes(root)) add(1, () => 'group', true);
  if (root === '/files' || root === '/media') {
    if (!['current', 'shared'].includes(words[1])) add(1, () => 'group', true);
    const operation = root === '/files' ? 2 : 3;
    if (['view', 'open', 'export', 'delete', 'confirm'].includes(words[operation]))
      add(operation + 1, w => `${root}:${w[1]}${root === '/media' ? ':' + w[2] : ''}`, false, words[operation] === 'confirm');
  }
  if (root === '/memory' || root === '/group-memory') {
    const operation = root === '/memory' ? 1 : 2;
    if (['view', 'export', 'confirm'].includes(words[operation]))
      add(operation + 1, w => `record:${root === '/memory' ? 'current' : w[1]}`, false, words[operation] === 'confirm');
  }
  if (root === '/contents' && words[1] === 'confirm') add(2, () => 'contents', false, true);
  if (root === '/web-access' && ['view', 'allow', 'deny'].includes(words[1])) add(2, () => 'web-request');
  if (root === '/content' && /^[a-f0-9]{32}$|^#[1-9]\d*$/.test(words[1] ?? '')) add(1, () => 'content');
  if (root === '/stop' && !['all', 'page'].includes(words[1])) add(1, () => 'conversation', true);
  return result;
}
function parsed(text) {
  const matches = [...text.matchAll(/\S+/g)];
  return { matches, words: matches.map(item => item[0]) };
}
function replaced(text, matches, changes) {
  for (const [index, value] of [...changes].reverse()) {
    const item = matches[index];
    text = text.slice(0, item.index) + value + text.slice(item.index + item[0].length);
  }
  return text;
}
export class CommandReferences {
  constructor(store, now = Date.now) {
    this.store = store; this.now = now; this.queue = new SerialQueue(); this.confirmations = new Map();
    this.path = join(store.root, 'command-references.json');
    this.groupNumber = async () => null; this.groupId = async () => null;
  }
  async read() {
    const state = await this.store.read(this.path, { next: 1, entries: {} });
    if (!Number.isSafeInteger(state?.next) || state.next < 1 || !state.entries
      || typeof state.entries !== 'object' || Array.isArray(state.entries)) throw new Error('COMMAND_REFERENCE_INVALID');
    return state;
  }
  prune() {
    for (const [id, entry] of this.confirmations) if (entry.until <= this.now()) this.confirmations.delete(id);
  }
  prepare(scope, controls) {
    validateControls(controls);
    return this.queue.run(async () => {
      this.prune(); let state, changed = false;
      const pending = new Map(this.confirmations);
      const translate = async text => {
        const { matches, words } = parsed(text); const changes = new Map();
        for (const slot of slots(words)) {
          const value = words[slot.index];
          if (!value) continue;
          const isRecord = slot.domain(words).startsWith('record:');
          if (!(isRecord ? /^[A-Za-z0-9_-]+$/ : /^[a-f0-9]{16,64}$/).test(value)) continue;
          const number = slot.group ? await this.groupNumber(value) : null;
          if (number) { changes.set(slot.index, String(number)); continue; }
          state ??= await this.read();
          const domain = slot.domain(words);
          const entries = slot.confirmation ? pending : new Map(Object.entries(state.entries));
          let key = [...entries].find(([, entry]) => entry.scope === scope && entry.domain === domain && entry.value === value)?.[0];
          if (!key) {
            if (!Number.isSafeInteger(state.next + 1)) throw new Error('COMMAND_REFERENCE_INVALID');
            key = String(state.next++); changed = true;
            const entry = { scope, domain, value };
            if (slot.confirmation) pending.set(key, { ...entry, until: this.now() + 600000 });
            else state.entries[key] = entry;
          }
          changes.set(slot.index, `#${key}`);
        }
        return replaced(text, matches, changes);
      };
      const rows = [];
      for (const row of controls.rows) {
        const items = [];
        for (const item of row) items.push({ ...item, command: await translate(item.command),
          ...(item.editCommand ? { editCommand: await translate(item.editCommand) } : {}) });
        rows.push(items);
      }
      if (changed) await this.store.write(this.path, state);
      this.confirmations = pending;
      return { ...controls, rows };
    });
  }
  async resolve(scope, text) {
    await this.queue.idle; this.prune(); let state;
    const { matches, words } = parsed(text); const changes = new Map();
    for (const slot of slots(words)) {
      const value = words[slot.index];
      if (!value) continue;
      let resolved;
      if (slot.group && /^[1-9]\d{4,15}$/.test(value)) {
        resolved = await this.groupId(value);
        if (!resolved) return { error: '未找到这个群号，请先发送 /groups 刷新列表。' };
      } else if (/^#[1-9]\d*$/.test(value)) {
        state ??= await this.read();
        const entry = slot.confirmation ? this.confirmations.get(value.slice(1)) : state.entries[value.slice(1)];
        if (!entry || entry.scope !== scope || entry.domain !== slot.domain(words))
          return { error: '对象编号不存在、不属于当前列表或确认已失效，请重新打开对应菜单。' };
        resolved = entry.value;
      }
      if (resolved) { words[slot.index] = resolved; changes.set(slot.index, resolved); }
    }
    return { text: replaced(text, matches, changes) };
  }
}
