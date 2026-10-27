import { z } from 'zod';
import { History } from '../history.mjs';
import { contentCodecs } from '../content-codecs.mjs';
import { toolFailure } from './register.mjs';
import { assertMessageAccess } from '../message-access.mjs';

const bvid = z.string().regex(/^BV[a-zA-Z0-9]{10}$/);

function videoFailure(error) {
  // Playwright wraps errors thrown inside evaluate; preserve known media error names only.
  const wrapped = String(error.message ?? '').match(/(?:^|[\s:])(FRAME_(?:TIMEOUT|TIMESTAMP_MISMATCH|CALLBACK_UNSUPPORTED)|PLAYER_(?:MEDIA_ERROR|DURATION_UNAVAILABLE))(?=$|\s)/)?.[1];
  const safe = wrapped ?? (/^[A-Z_]{3,80}$/.test(error.message) ? error.message
    : /^[A-Z_]{3,80}$/.test(error.code ?? '') ? error.code
    : error.name === 'TimeoutError' ? 'BILIBILI_TIMEOUT'
    : /net::ERR_|ECONNRESET|ETIMEDOUT/.test(error.message ?? '') ? 'BILIBILI_NETWORK_FAILED' : 'TOOL_FAILED');
  const recovery = /LOGIN_REQUIRED/.test(safe)
    ? '需要机管检查B站登录；无字幕时可尝试可访问的画面，不要假装已经观看。'
    : /TIMEOUT|NETWORK|UNAVAILABLE/.test(safe) ? 'B站访问异常，与Codex连接故障不同。本轮不要反复请求同一页面；可如实结束，之后再找。'
    : /FRAME_|PLAYER_|TIMESTAMP_|CANDIDATE_|NO_CANDIDATES/.test(safe) ? '仅当前候选或画面不可用，换可访问时间点或其他视频；不要重建Codex登录。'
    : '保留错误供内部排障；公开回复仅自然说明资料缺口，不播报技术码，不编造原因。项目权限错误不能通过其他工具绕过。';
  const failure = toolFailure(new Error(safe), recovery);
  if (error.accessibleRange) failure.content.push(contentCodecs.value('json', { accessible_range: error.accessibleRange }));
  if (error.bilibiliLoggedOut) failure.content.push(contentCodecs.value('json', { bilibili_login: 'session_invalid' }));
  return failure;
}

export function registerVideoTools(registerTool, { scope, store, browser, stageImages }) {
  const register = (...args) => registerTool(...args, videoFailure);
  const subtitleCache = new Map();
  register('discover_videos', 'Get a fresh numbered batch. Use query to search a topic discussed by users, or omit it for recommendations.', { query: z.string().max(100).default('') }, async args => [contentCodecs.value('json', await browser.discover(args.query))]);
  register('select_video', 'Resolve an id within the specified candidate batch.', {
    list_id: z.string().uuid(), id: z.string().regex(/^v\d+$/),
  }, async args => {
    const selected = browser.select(args.list_id, args.id);
    await store.saveActivity(scope, { bvid: selected.bvid, title: selected.title });
    return [contentCodecs.value('json', selected)];
  });
  register('get_subtitles', 'Read a bounded subtitle time window. No local audio transcription.', {
    bvid, start_seconds: z.number().nonnegative().default(0), end_seconds: z.number().nonnegative().default(120),
  }, async args => {
    if (args.end_seconds <= args.start_seconds) throw new Error('INVALID_TIME_WINDOW');
    let result = subtitleCache.get(args.bvid);
    if (!result) {
      result = await browser.subtitles(args.bvid);
      if (result.status === 'AVAILABLE') subtitleCache.set(args.bvid, result);
      if (subtitleCache.size > 2) subtitleCache.delete(subtitleCache.keys().next().value);
    }
    const matching = (result.cues ?? []).filter(cue => cue.end_seconds >= args.start_seconds && cue.start_seconds < args.end_seconds);
    const cues = [];
    let length = 0;
    for (const cue of matching.slice(0, 100)) {
      const size = JSON.stringify(cue).length;
      if (length + size > 12000) break;
      cues.push(cue); length += size;
    }
    await store.saveActivity(scope, { bvid: args.bvid, title: result.title });
    return [contentCodecs.value('json', { bvid: args.bvid, title: result.title, status: result.status, language: result.selectedLanguage,
      ...(result.needLogin ? { bilibili_login: 'required' } : {}),
      totalCues: result.cues?.length ?? 0, cues, truncated: cues.length < matching.length })];
  });
  register('get_frames', 'Read ONE actual rendered player-container screenshot at seconds, including visible overlays/UI. Also returns visible DOM danmaku/subtitle text and a temporary asset_id usable with send_reply until this turn ends; save_file(asset_id,name) explicitly keeps it. Inspect it before choosing another timestamp. This is not a batch operation. On range errors choose an earlier accessible time. Empty overlay text does not prove no comments exist.', {
    bvid, seconds: z.number().nonnegative(), turn_id: z.string().uuid(),
  }, async args => {
    await assertMessageAccess(scope, store);
    await stageImages.ensure(scope, args.turn_id);
    const frame = await browser.frame(args.bvid, args.seconds);
    const source = { kind: 'bilibili_player', bvid: args.bvid, seconds: frame.seconds };
    const asset = await stageImages.save(scope, frame.image, { label: `${args.bvid} @ ${frame.seconds}s`, source, turnId: args.turn_id });
    return [contentCodecs.value('json', { bvid: args.bvid, untrusted: true, accessible_range: frame.accessible_range, capture: frame.capture,
      visible_text: frame.visible_text, asset }),
      contentCodecs.value('image', { bytes: frame.image, mimeType: 'image/jpeg',
        source: { kind: 'bilibili_frame', capture: frame.capture, bvid: args.bvid, seconds: frame.seconds, asset_id: asset.asset_id } })];
  });
  register('get_player_text', 'Read currently exposed visible danmaku/subtitle DOM text at a Bilibili timestamp without taking or saving a screenshot. Reuses the real player and may briefly play to seek. Not complete comment history; canvas, disabled or unloaded overlays may be absent. For visual evidence use get_frames.', {
    bvid, seconds: z.number().nonnegative(),
  }, async args => {
    await assertMessageAccess(scope, store);
    const result = await browser.frame(args.bvid, args.seconds, { capture: false });
    await assertMessageAccess(scope, store);
    return [contentCodecs.value('json', { source: { kind: 'bilibili_player_text', bvid: args.bvid }, untrusted: true, ...result })];
  });
  register('remember_video', 'Persist a concise video summary separately from the agent conversation.', {
    bvid, title: z.string().min(1).max(300), summary: z.string().min(1).max(6000),
    comment: z.string().max(200).default('').describe('公开视频短评；重要资料缺口用自然语言说明，不包含工具错误码、账号登录状态或内部排障信息'),
    observations: z.array(z.object({ seconds: z.number().nonnegative(), text: z.string().max(500) })).max(12).default([]),
    uncertainty: z.string().max(1000).default('').describe('内部证据限制和工具异常，供后续核实及机管排障，不直接公开分享'),
  }, async args => { await store.remember(scope, args); return [contentCodecs.value('json', { saved: true, bvid: args.bvid })]; });
  register('recall_videos', 'Recall this conversation’s summaries and public browsing history. These contain video information only, not other conversations.', {
    query: z.string().max(80).default(''),
  }, async args => [contentCodecs.value('json', { videos: await store.context(scope, 8000, args.query), public_history: (await new History(store).records(args.query)).slice(0, 6) })]);
}
