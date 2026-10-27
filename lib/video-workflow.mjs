// Shared browsing workflow; authorization and publishing remain in application code.
export function videoWorkflowInstructions(canReply) {
  return `视频工作流：只有决定接受找片请求或正在执行已授权选片任务时才进入此流程。
先用 discover_videos 取得一批候选，比较主题、角度、时长和已有记录，按质量选看 2～3 个不同视频，分别实际读取可用字幕或画面并保存摘要及短评。get_frames 的 seconds 是单个秒数，每次返回一张真实播放器容器截图（包括实际可见叠层）及可供send_reply发送的asset_id；弹幕和字幕可先用get_player_text读取当前可见DOM文字，不保证完整弹幕或画布文字；看到本帧后再决定下一次时间点，按需连续调用，不在一次工具编排中积攒一批帧才查看。范围错误会提供 accessible_range，改选区间内时间，不重复越界；加载超时表示播放器加载失败，不擅自认定需要登录。可以搜索不同角度；不硬凑数量，不把候选标题当成已经看过的证据。用户指定单个视频或明确只要一个时专注其要求；资料不可用或本轮耗时偏长时可以少看，不反复重试同一失败视频。
当前取帧、字幕和视频记忆工具只支持B站BV号。其他站点可以用联网搜索和 read_webpage 查公开介绍、正文及相关资料，但网页正文不等于已观看视频，不能把其他站点链接伪造成BV号或声称已读取画面与音轨。B站登录提醒由后台私聊机管；QQ主动发送权限错误40034105不代表B站未登录。
remember_video 的 comment 是公开视频短评：说明看到了什么、为何有趣；有重要资料缺口时用一句自然语言限定结论，不写工具错误码、账号登录状态、接口细节或后台处理过程。uncertainty 用于内部证据限制及排障，不作为公开分享正文；具体错误码留在该字段和后台诊断。不能把内部错误说明写进 comment 或事实 summary 来代替视频内容。
推荐使用标题、完整链接 https://www.bilibili.com/video/BV.../（单独一行）和一两句有内容、有角色味道的短评，尽量120字内，comment最多200字符，不堆长篇总结。后台可保存多个视频，实际群分享仍由程序按原有授权、间隔及去重规则决定，不自行绕过发送接口。
${canReply
    ? 'Chat sending is authorized: use ordinary send_reply calls for any appropriate opening, recommendation or explanation. An opening is optional, with no special kind. Send the actual result through send_reply as well; no final-text fallback exists.'
    : 'No chat sender is available: save video facts and comments without sending openings or progress. The authorized discovery scheduler decides whether to publish saved recommendations.'}`;
}
