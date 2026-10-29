import { action, interaction } from './interaction.mjs';

const safeLabel = value => String(value ?? '').replace(/[\r\n*_`<>\[\]#]/g, ' ');
const token = id => Buffer.from(id).toString('base64url');
const time = value => {
  if (!value) return '时间未提供';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未提供';
};
const title = record => `${time(record.timestamp)} · ${safeLabel(record.speaker?.name || '未提供昵称')}`;
function body(record) {
  return record.components.map(item => {
    if (item.type === 'text') return item.text + (item.truncated ? '\n［本条正文仅保留了部分内容］' : '');
    if (item.type === 'card') return `［分享卡片］${item.title || item.prompt || ''}\n${item.description || ''}\n${(item.links ?? (item.url ? [item.url] : [])).join('\n') || '未保留可用浏览链接'}`;
    if (item.type === 'record' || item.type === 'record_ref') return '［引用或转发记录：内层正文未在此展开］';
    if (item.type === 'mentions') return '［提及信息］';
    const kind = { image: '图片', audio: '音频', video: '视频', file: '文件' }[item.type];
    return kind ? `［${kind}］${item.filename || ''}${item.transcript?.text ? `\n平台转写（未核实）：${item.transcript.text}` : ''}` : '［其他消息内容］';
  }).join('\n') || '（未保留正文）';
}

// Operator-only presentation. No inference, media download or new chat storage.
export async function chatRecordView(c, { adminScope, scope, group, name, command, value }) {
  const match = /^(list)(?: (\d{1,7}))?$|^(view|export) ([A-Za-z0-9_-]{1,1100})(?: (\d{1,7}))?$/.exec(value);
  if (!match) return null;
  const back = action('返回聊天记录管理', command);
  const check = async record => {
    if (c.closed || !adminScope.startsWith('c2c:') || !c.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REVOKED');
    if (group) {
      const current = await c.groupAccess.read(group.id);
      if (!current?.allowed || !current.listen || current.openid !== group.openid) throw new Error('GROUP_MESSAGES_DISABLED');
    } else if (scope !== adminScope) throw new Error('ADMIN_ACCESS_REQUIRED');
    if (record) {
      const current = await c.messageRecords.find(scope, record.messageId);
      if (!current || JSON.stringify(current) !== JSON.stringify(record)) throw new Error('MESSAGE_NOT_RETAINED');
    }
  };
  await check();
  if (match[1]) {
    const result = await c.messageRecords.list(scope, Math.max(1, Number(match[2]) || 1));
    for (const record of result.items) await check(record);
    await check();
    const rows = [];
    for (let i = 0; i < result.items.length; i += 2) rows.push(result.items.slice(i, i + 2).map((record, index) =>
      action(`查看第 ${(result.page - 1) * 8 + i + index + 1} 条`, `${command} view ${token(record.messageId)}`)));
    const nav = [];
    if (result.page > 1) nav.push(action('上一页', `${command} list ${result.page - 1}`));
    if (result.page < result.pages) nav.push(action('下一页', `${command} list ${result.page + 1}`));
    rows.push([...nav, back]);
    return interaction(`## ${name} · 已保留的收到消息\n共 ${result.total} 条，第 ${result.page}/${result.pages} 页（北京时间）。\n仅限机器人实际保留的消息，不含完整机器人回复；不是 QQ 完整聊天历史。\n\n${result.items.map((record, i) => `${(result.page - 1) * 8 + i + 1}. ${title(record)}\n${safeLabel(body(record)).slice(0, 100)}`).join('\n\n') || '暂时没有保留的消息。'}`, rows);
  }
  const [, , , operation, encoded, rawPage] = match;
  const id = Buffer.from(encoded, 'base64url').toString('utf8');
  if (token(id) !== encoded) throw new Error('INVALID_DETAIL_PAGE');
  const record = await c.messageRecords.find(scope, id);
  if (!record) return interaction('这条消息已过期或不存在，请刷新列表。', [[action('返回消息列表', `${command} list`)]]);
  await check(record);
  const text = `${name} · 已保留的收到消息\n${title(record)}\n\n${body(record)}\n\n附件以文字索引显示；引用或转发的内层正文未展开。此内容不等于 QQ 完整记录。`;
  if (operation === 'export') return { ...interaction('已附上这条消息保留内容的 TXT 文件。', [[action('返回消息列表', `${command} list`)]]),
    file: { name: 'chat-record.txt', text, assertAccess: () => check(record) } };
  const characters = Array.from(text); const pages = Math.max(1, Math.ceil(characters.length / 1000));
  const page = Math.min(pages, Math.max(1, Number(rawPage) || 1));
  const nav = [];
  if (page > 1) nav.push(action('上一页', `${command} view ${encoded} ${page - 1}`));
  if (page < pages) nav.push(action('下一页', `${command} view ${encoded} ${page + 1}`));
  return interaction(`## 消息正文 · 第 ${page}/${pages} 页\n\n${characters.slice((page - 1) * 1000, page * 1000).join('')}`, [
    ...(nav.length ? [nav] : []), [action('导出本条 TXT', `${command} export ${encoded}`)],
    [action('返回消息列表', `${command} list`), back],
  ]);
}
