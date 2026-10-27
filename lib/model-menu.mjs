import { action, controls, interaction } from './interaction.mjs';

// Five buttons total, including navigation and return; one per row.
export function modelMenu(models, selectedModel, requestedPage = 1, {
  list = '/models', select = '/model', environment = '当前私聊', back = controls.chat,
} = {}) {
  if (!models.length) return interaction('暂时没有可选模型，请稍后再试。', [[back]]);
  const chunks = [];
  for (let offset = 0; offset < models.length;) {
    const capacity = chunks.length ? 3 : 4;
    const count = models.length - offset <= capacity ? capacity : chunks.length ? 2 : 3;
    chunks.push(models.slice(offset, offset + count)); offset += count;
  }
  const page = Math.min(chunks.length, Math.max(1, Number(requestedPage) || 1));
  const current = selectedModel ?? models.find(model => model.isDefault)?.id;
  const clean = value => String(value ?? '').replace(/[\r\n*_`<>\[\]#]/g, ' ').slice(0, 80);
  const items = chunks[page - 1];
  const listing = items.map((model, index) => `- ${index + 1}. ${clean(model.name || model.id)}${model.name && model.name !== model.id ? `（${clean(model.id)}）` : ''}${model.id === current ? ' ✓ 当前' : ''}`).join('\n');
  const rows = items.map((model, index) => [action(`${index + 1} ${model.name || model.id}`, `${select} ${model.id}`)]);
  if (page > 1) rows.push([action('上一页', `${list} ${page - 1}`)]);
  if (page < chunks.length) rows.push([action('下一页', `${list} ${page + 1}`)]);
  rows.push([back]);
  return interaction(`## 选择模型（${page}/${chunks.length}）\n用于：${environment}\n${listing}\n\n选择后从下一轮生效。`, rows);
}
