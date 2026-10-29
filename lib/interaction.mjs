// Operator pages retain structured actions; channels render copyable commands.
export const action = (label, command, options = {}) => ({ label, command, ...options });
export const controls = {
  history: action('浏览历史', '/history'),
  debug: action('发送诊断报告', '/debug'),
  status: action('查看状态', '/status'),
  models: action('切换模型', '/models'),
  thinking: action('思考深度', '/thinking'),
  cancel: action('停止任务', '/stop'),
  groups: action('群聊设置', '/groups'),
  settings: action('机管设置', '/settings'),
  chat: action('私聊设置', '/settings chat'),
  persona: action('角色风格', '/persona'),
  preferences: action('内容偏好', '/preferences'),
  watch: action('推荐内容', '找 2～3 条值得看的网页、视频或音频，实际读取内容后给出完整来源链接和简短评论。'),
};
export function interaction(text, rows, prompt = '可用指令：') {
  return { text, buttons: { rows, prompt } };
}
export function overview(text, admin) {
  return interaction(text, admin
    ? [[controls.watch, controls.history], [controls.cancel, controls.settings]]
    : [[controls.watch, controls.history], [controls.status]]);
}

export function validateControls({ rows }) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 5
    || rows.some(row => !Array.isArray(row) || !row.length || row.length > 5
      || row.some(item => typeof item.label !== 'string' || typeof item.command !== 'string'))) {
    throw new Error('INVALID_BUTTON_LAYOUT');
  }
}

// Keep executable commands verbatim on their own lines, including edit prefixes.
export function commandInstructions(controls) {
  validateControls(controls);
  return ['复制对应指令并发送；标注“编辑”的指令请先补充或修改内容。'
    + (controls.rows.flat().some(item => item.command.startsWith('/操作 ')) ? '\n操作编号仅限当前对话，十分钟内有效；重启后请重新打开菜单。' : ''),
    ...controls.rows.flat().map(item => `${item.label}${item.enter === false ? '（编辑后发送）' : ''}\n${item.command}`)].join('\n\n');
}
