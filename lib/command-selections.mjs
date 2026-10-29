import { join } from 'node:path';
import { SerialQueue } from './serial-queue.mjs';
import { validateControls, editInstructions } from './interaction.mjs';

// Only opaque internal command arguments need aliases. Simple commands stay readable.
const opaque = command => /\b[a-f0-9]{16,64}\b/i.test(command) || /^\/memory (?:view|export) /.test(command);
export class CommandSelections {
  constructor(store, now = Date.now) {
    this.store = store; this.now = now; this.queue = new SerialQueue(); this.entries = new Map();
    this.path = join(store.root, 'command-sequence.json');
  }
  prune() {
    for (const [id, entry] of this.entries) if (entry.until <= this.now()) this.entries.delete(id);
    while (this.entries.size > 1000) this.entries.delete(this.entries.keys().next().value);
  }
  prepare(scope, controls) {
    validateControls(controls);
    return this.queue.run(async () => {
      this.prune();
      const count = controls.rows.flat().filter(item => opaque(item.command)).length;
      if (!count) return controls;
      const state = await this.store.read(this.path, { next: 1 });
      if (!Number.isSafeInteger(state.next) || state.next < 1 || !Number.isSafeInteger(state.next + count))
        throw new Error('COMMAND_SEQUENCE_INVALID');
      // Persist the high-water mark before exposing aliases. Restart discards
      // mappings but never reassigns an old number to a different operation.
      await this.store.write(this.path, { next: state.next + count });
      let id = state.next;
      const rows = controls.rows.map(row => row.map(item => {
        if (!opaque(item.command)) return item;
        const key = String(id++);
        this.entries.set(key, { scope, command: item.command, edit: item.enter === false,
          prefix: item.editCommand ?? item.command.trim(), input: item.input, until: this.now() + 600000 });
        return { label: item.label, command: `/action ${key}`, ...(item.enter === false ? { enter: false, input: item.input } : {}) };
      }));
      this.prune();
      return { ...controls, rows };
    });
  }
  resolve(scope, text) {
    this.prune();
    const match = /^\/action ([1-9]\d*)(?: ([^\r\n]+))?$/.exec(text);
    const entry = match && this.entries.get(match[1]);
    if (!entry || entry.scope !== scope) return { error: '操作编号已失效或不属于当前对话，请重新打开对应菜单。' };
    const value = match[2]?.trim();
    if (entry.edit && !value) return { error: `请补全此操作的参数。\n${editInstructions({ command: `/action ${match[1]}`, input: entry.input })}` };
    if (!entry.edit && value) return { error: '此操作无需附加内容，请直接发送菜单里的指令。' };
    return { text: entry.edit ? `${entry.prefix} ${value}` : entry.command };
  }
}
