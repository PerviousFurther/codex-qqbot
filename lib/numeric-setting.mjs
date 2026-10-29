import { action, interaction } from './interaction.mjs';

export function settingNumber(raw, { min, max }) {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function numericSetting({ environment, spec, current, command, back, notice = '' }) {
  return interaction(`${environment}\n${spec.title}：${current}\n范围 ${spec.min}～${spec.max}，填写整数。\n复制“编辑数值”对应的指令，在操作编号后加空格并填写新数值，再发送。${notice ? `\n\n${notice}` : ''}`, [
    [action('编辑数值', `${command} ${current}`, { enter: false, editCommand: command })],
    spec.presets.map(value => action(String(value), `${command} ${value}`)), [back],
  ]);
}
