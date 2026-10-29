import { join } from 'node:path';
import { SerialQueue } from './serial-queue.mjs';
import { validateControls, editInstructions } from './interaction.mjs';

const opaque = command => /\b[a-f0-9]{16,64}\b/i.test(command) || /^\/memory (?:view|export) /.test(command);
export class CommandSelections {
  constructor(store, now = Date.now) {
    this.store = store; this.now = now; this.queue = new SerialQueue(); this.confirmations = new Map();
    this.path = join(store.root, 'command-sequence.json');
  }
  async read() {
    const state = await this.store.read(this.path, { next: 1, entries: {} });
    if (!Number.isSafeInteger(state?.next) || state.next < 1
      || state.entries !== undefined && (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)))
      throw new Error('COMMAND_SEQUENCE_INVALID');
    return { ...state, entries: state.entries ?? {} };
  }
  prune() {
    for (const [id, entry] of this.confirmations) if (entry.until <= this.now()) this.confirmations.delete(id);
  }
  prepare(scope, controls) {
    validateControls(controls);
    return this.queue.run(async () => {
      this.prune();
      if (!controls.rows.flat().some(item => opaque(item.command))) return controls;
      const state = await this.read(); let changed = false;
      const pending = new Map(this.confirmations);
      const rows = controls.rows.map(row => row.map(item => {
        if (!opaque(item.command)) return item;
        const edit = item.enter === false;
        // An editable action identifies its operation, not its displayed default.
        const command = (edit ? item.editCommand ?? item.command : item.command).trim();
        const confirmation = /(?:^| )confirm [a-f0-9]+$/.test(command);
        const entries = confirmation ? pending : new Map(Object.entries(state.entries));
        let key = [...entries].find(([, entry]) => entry.scope === scope && entry.command === command && entry.edit === edit)?.[0];
        if (!key) {
          if (!Number.isSafeInteger(state.next + 1)) throw new Error('COMMAND_SEQUENCE_INVALID');
          key = String(state.next++); changed = true;
        }
        const entry = { scope, command, edit, ...(item.input ? { input: item.input } : {}) };
        if (confirmation) pending.set(key, { ...entry, until: entries.get(key)?.until ?? this.now() + 600000 });
        else if (JSON.stringify(state.entries[key]) !== JSON.stringify(entry)) {
          state.entries[key] = entry; changed = true;
        }
        return { label: item.label, command: `/action ${key}`, ...(edit ? { enter: false, input: item.input } : {}) };
      }));
      // Publish before exposing new numbers. Ordinary mappings survive restart;
      // single-use confirmation tokens stay transient and are never reassigned.
      if (changed) await this.store.write(this.path, state);
      this.confirmations = pending;
      return { ...controls, rows };
    });
  }
  async resolve(scope, text) {
    await this.queue.idle; this.prune();
    const match = /^\/action ([1-9]\d*)(?: ([^\r\n]+))?$/.exec(text);
    const entry = match && (this.confirmations.get(match[1]) ?? (await this.read()).entries[match[1]]);
    if (!entry || entry.scope !== scope) return { error: '操作编号不存在、确认已失效或不属于当前对话，请重新打开对应菜单。' };
    const value = match[2]?.trim();
    if (entry.edit && !value) return { error: `请补全此操作的参数。\n${editInstructions({ command: `/action ${match[1]}`, input: entry.input })}` };
    if (!entry.edit && value) return { error: '此操作无需附加内容，请直接发送菜单里的指令。' };
    return { text: entry.edit ? `${entry.command} ${value}` : entry.command };
  }
}
