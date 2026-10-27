import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { checkedQQReply } from './qq-diagnostics.mjs';

export const QQ_MENU_ITEMS = [
  { name: '帮助', type: 'send_message', send_message: '/help' },
  { name: '机管设置', type: 'menu', sub_menu_items: [
    { name: '设置首页', type: 'send_message', send_message: '/settings' },
    { name: '私聊设置', type: 'send_message', send_message: '/settings chat' },
    { name: '群聊设置', type: 'send_message', send_message: '/groups' },
  ] },
  { name: '停止任务', type: 'send_message', send_message: '/stop' },
];

// Replace entries owned by this service, including names from the old menu.
// Preserve operator-supplied unrelated entries and the original menu backup.
const managedMenuNames = new Set([...QQ_MENU_ITEMS.map(item => item.name), '看视频', '视频记录', '浏览历史', '状态', '暂停', '管理']);

export function commandKeyboard({ rows }, { autoSend = true } = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 5
    || rows.some(row => !Array.isArray(row) || !row.length || row.length > 5)) {
    throw new Error('INVALID_BUTTON_LAYOUT');
  }
  const button = (id, label, data, enter) => ({
    id, render_data: { label, visited_label: label, style: 1 },
    action: { type: 2, permission: { type: 2 },
      data, enter, unsupport_tips: '请手动发送按钮对应的命令。' },
  });
  return { content: { rows: rows.map((row, rowIndex) => ({ buttons: row.map((item, column) => {
    const label = item.label;
    const characters = Array.from(label);
    return button(`action-${rowIndex}-${column}`,
      characters.length > 10 ? `${characters.slice(0, 9).join('')}…` : label, item.command,
      autoSend && item.enter !== false);
  }) })) } };
}

export async function syncQQMenu(bot, store) {
  const response = await bot.api.get('/v2/menu');
  checkedQQReply(response);
  if (!response || !Object.hasOwn(response, 'menu')) throw new Error('INVALID_QQ_MENU_RESPONSE');
  const previous = response?.menu ?? { items: [] };
  const current = previous.items ?? [];
  if (!Array.isArray(current) || current.some(item => !item || typeof item.name !== 'string')) {
    throw new Error('INVALID_QQ_MENU_RESPONSE');
  }
  const items = [...structuredClone(QQ_MENU_ITEMS), ...current.filter(item => !managedMenuNames.has(item.name))];
  if (items.length > 10) throw new Error('QQ_MENU_FULL');
  // QQ adds default icons to the saved menu; those are not configuration changes.
  const comparable = entries => entries.map(({ icon, sub_menu_items, ...item }) => ({
    ...item, ...(sub_menu_items ? { sub_menu_items: comparable(sub_menu_items) } : {}),
  }));
  if (isDeepStrictEqual(comparable(current), comparable(items))) return 'menu_unchanged';

  // Back up the original menu before the first update; keep unrelated entries.
  const backup = join(store.root, 'qq-menu-backup.json');
  if (await store.read(backup, null) === null) {
    await store.write(backup, { menu: previous, version: response?.version,
      savedAt: new Date().toISOString() });
  }
  const result = await bot.api.put('/v2/menu', { menu: { items } });
  checkedQQReply(result);
  return 'menu_updated';
}
