// Explicitly approved bot capabilities. New tools require a deliberate policy entry.
const BASE_TOOL_POLICY = {
  list_files: { readOnlyHint: true, destructiveHint: false },
  read_file: { readOnlyHint: true, destructiveHint: false },
  save_file: { readOnlyHint: false, destructiveHint: true },
  delete_file: { readOnlyHint: false, destructiveHint: true },
  check_pending_events: { readOnlyHint: true, destructiveHint: false },
  wait_reply: { readOnlyHint: true, destructiveHint: false },
  set_interrupt_guard: { readOnlyHint: false, destructiveHint: false },
  get_message_detail: { readOnlyHint: true, destructiveHint: false },
  list_context_chats: { readOnlyHint: true, destructiveHint: false },
  search_qq_faces: { readOnlyHint: true, destructiveHint: false },
  search_qq_history: { readOnlyHint: true, destructiveHint: false },
  read_chat_context: { readOnlyHint: true, destructiveHint: false },
  read_media: { readOnlyHint: true, destructiveHint: false },
  close_media: { readOnlyHint: false, destructiveHint: false },
  get_audio_detail: { readOnlyHint: true, destructiveHint: false },
  read_webpage: { readOnlyHint: false, destructiveHint: false },
  open_webpage: { readOnlyHint: false, destructiveHint: false },
  scroll_webpage: { readOnlyHint: false, destructiveHint: false },
  screenshot_webpage: { readOnlyHint: false, destructiveHint: false },
  get_webpage_dom: { readOnlyHint: false, destructiveHint: false },
  edit_webpage_dom: { readOnlyHint: false, destructiveHint: true },
  click_webpage: { readOnlyHint: false, destructiveHint: true },
  type_webpage: { readOnlyHint: false, destructiveHint: true },
  press_webpage: { readOnlyHint: false, destructiveHint: true },
  back_webpage: { readOnlyHint: false, destructiveHint: false },
  close_webpage: { readOnlyHint: false, destructiveHint: false },
  upload_file: { readOnlyHint: false, destructiveHint: true },
  list_webpage_media: { readOnlyHint: false, destructiveHint: false },
  read_webpage_media: { readOnlyHint: false, destructiveHint: false },
  get_webpage_subtitles: { readOnlyHint: false, destructiveHint: false },
  get_image_detail: { readOnlyHint: true, destructiveHint: false },
  remember_content: { readOnlyHint: false, destructiveHint: false },
  recall_content: { readOnlyHint: true, destructiveHint: false },
};

const GROUP_TOOL_POLICY = {
  recall_group_context: { readOnlyHint: true, destructiveHint: false },
  compact_group_context: { readOnlyHint: false, destructiveHint: false },
};

const REPLY_TOOL_POLICY = { send_reply: { readOnlyHint: false, destructiveHint: false } };

export function toolPolicy(allowGroupContext = false, allowReplies = false) {
  return { ...BASE_TOOL_POLICY, ...(allowReplies ? REPLY_TOOL_POLICY : {}), ...(allowGroupContext ? GROUP_TOOL_POLICY : {}) };
}

export function toolApprovals(allowGroupContext = false, allowReplies = false) {
  const names = Object.keys(toolPolicy(allowGroupContext, allowReplies));
  return { enabled_tools: names, default_tools_approval_mode: 'prompt',
    tools: Object.fromEntries(names.map(name => [name, { approval_mode: 'approve' }])) };
}
