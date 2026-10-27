// Channel-independent interaction: Markdown content, then command button rows.
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
  preferences: action('视频偏好', '/preferences'),
  watch: action('推荐视频', '找 2～3 条值得看的 B 站视频，实际读取内容后给出完整链接和简短评论。'),
};
export function interaction(text, rows, prompt = '请选择操作：') {
  return { text, buttons: { rows, prompt } };
}
export function overview(text, admin) {
  return interaction(text, admin
    ? [[controls.watch, controls.history], [controls.cancel, controls.settings]]
    : [[controls.watch, controls.history], [controls.status]]);
}
