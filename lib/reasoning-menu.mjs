import { action, interaction } from './interaction.mjs';

const labels = { none: '不额外推理', minimal: '极轻量', low: '轻量', medium: '标准', high: '深入', xhigh: '更深入', max: '最大深度', ultra: '极深' };
export const effortLabel = value => labels[value] ?? value ?? '模型默认';

export function reasoningMenu(model, selected, requestedPage = 1, { thinking = '/thinking', environment = '当前私聊', back } = {}) {
  const options = [{ id: 'default', name: `模型默认${model?.defaultEffort ? `（${effortLabel(model.defaultEffort)}）` : ''}` },
    ...(model?.efforts ?? []).map(item => ({ id: item.id, name: effortLabel(item.id) }))];
  const pages = Math.max(1, Math.ceil(options.length / 8));
  const page = Math.min(pages, Math.max(1, Number(requestedPage) || 1));
  const items = options.slice((page - 1) * 8, page * 8);
  const rows = [];
  for (let index = 0; index < items.length; index += 2) rows.push(items.slice(index, index + 2)
    .map(item => action(`${item.id === (selected ?? 'default') ? '✓ ' : ''}${item.name}`, `${thinking} ${item.id}`)));
  const nav = [];
  if (page > 1) nav.push(action('上一页', `${thinking} page ${page - 1}`));
  if (page < pages) nav.push(action('下一页', `${thinking} page ${page + 1}`));
  if (back) nav.push(back);
  if (nav.length) rows.push(nav);
  return interaction(`## 思考深度 · ${environment}\n模型：${model?.id ?? '暂不可用'}\n当前：${selected ? effortLabel(selected) : options[0].name}\n${model?.efforts?.length ? '思考越深入，通常等待越久。此设置只影响本对话。' : '这个模型暂不支持调整，使用默认设置。'}`, rows);
}
