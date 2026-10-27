import { diagnosticSummary } from './diagnostic-summary.mjs';
import { action, interaction } from './interaction.mjs';
import { diagnosticEvents, diagnosticFile } from './diagnostic-file.mjs';
import { scopeId } from './policy.mjs';
import { groupLabel } from './group-platform.mjs';
import { groupPolicy } from './group-policy.mjs';

// One operator-facing export. Cached metadata only: no model, platform query,
// message-body read, saved video contents or diagnostic navigation pages.
export async function diagnosticReport(bot, scope) {
  const groups = (await bot.groupAccess.records()).slice(0, 50);
  const sources = ['system', scope, ...groups.map(group => `group:${group.openid}`)];
  const events = []; const counters = {};
  for (const source of sources) {
    const data = bot.debug.read(source);
    events.push(...diagnosticEvents(data).map(event => ({ ...event, scope: scopeId(source) })));
    for (const [key, value] of Object.entries(data.counters ?? {})) {
      if (/^[a-z_]{1,100}$/.test(key) && Number.isFinite(value)) counters[key] = (counters[key] ?? 0) + value;
    }
  }
  const current = await bot.store.conversation(scope); const lane = bot.lane(scope);
  const summary = diagnosticSummary({ events, currentScope: scopeId(scope), closed: bot.closed, current: { state: lane.state, pending: lane.pending },
    audio: { model: !!process.env.WATCH_AUDIO_MODEL_DIR?.trim(), vad: !!process.env.WATCH_AUDIO_VAD_MODEL?.trim() },
    groups: groups.map(group => ({ scope: scopeId(`group:${group.openid}`), name: groupLabel(group),
      allowed: !!group.allowed, blocked: group.taskBlocked, pending: bot.lane(`group:${group.openid}`).pending,
      listen: !!group.listen, engage: !!group.engage, push: !!group.push, oldSendError: !!group.pushError })),
  });
  const detail = [
    `service: ${bot.closed ? 'closed' : 'running'}`,
    `current_private: ${JSON.stringify({ scope: scopeId(scope), state: lane.state, pending: lane.pending,
      model: current.model ?? null, reasoningEffort: current.reasoningEffort ?? null, autobrowse: lane.autobrowse,
      guarded: lane.events?.status().guarded ?? false })}`,
    `groups_included: ${groups.length} (maximum 50)`,
    ...groups.map(group => {
      const active = bot.lane(`group:${group.openid}`);
      return `group: ${JSON.stringify({ id: group.id, name: groupLabel(group), allowed: !!group.allowed,
        listen: !!group.listen, engage: !!group.engage, push: !!group.push, toolMonitor: group.toolMonitor === true, feedbackTarget: 'administrators', taskBlocked: group.taskBlocked ?? null,
        lastTaskFailure: group.lastTaskFailure ?? null, lastSendError: group.pushError ?? null,
        state: active.state, pending: active.pending, schedule: groupPolicy(group),
        notifyReplyLimit: group.notifyReplyLimit === true,
        platform: { infoCheckedAt: group.platform?.info?.checkedAt ?? null, stateCheckedAt: group.platform?.state?.checkedAt ?? null,
          infoError: group.platform?.info?.error ?? null, stateError: group.platform?.state?.error ?? null,
          receiveMode: group.platform?.state?.value?.recv_msg_setting ?? null } })}`;
    }),
    ...(bot.debug.saveError ? [`diagnostic_storage_error: ${bot.debug.saveError}`] : []),
  ].join('\n');
  return { ...interaction('## 诊断报告\n已附上 TXT 文件，可转交维护人员排查。\n报告包含运行状态和错误记录，不含聊天正文或登录凭据。', [[action('返回运行反馈', '/settings display')]]),
    file: diagnosticFile({ title: '机器人诊断报告', summary, detail, data: { counters, events } }) };
}
