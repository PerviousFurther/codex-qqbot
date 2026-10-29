import { groupLabel } from './group-label.mjs';
import { redactCredentials, scopeId } from './policy.mjs';

const messageFor = reason => ['QQ_REPLY_FAILED', 'QQ_PUSH_FAILED', 'GROUP_REPLY_STATE_WRITE_FAILED'].includes(reason) ? '消息未能确认送达，后续发送已停止。请先查看聊天，避免重复发送。'
  : reason === 'STATE_JSON_CORRUPT' ? '保存的数据暂时无法读取，自动任务已暂停。请发送诊断报告交给维护人员处理，暂不要清空记录。'
  : reason === 'REASONING_EFFORT_UNAVAILABLE' ? '当前思考深度不可用，请在对应私聊或群聊的设置中重新选择。'
  : reason === 'SHARED_STATE_WRITE_FAILED' ? '角色状态暂时未能保存，本次回复已保留。'
  : reason === 'CODEX_TURN_TIMEOUT' ? '本轮模型处理超过配置的时限，已结束。'
  : '本次处理未能完成，可稍后重试。需要帮助时，可在机管设置的“运行反馈”中发送诊断报告。';

const modelMessage = (agentCode, status) => agentCode === 'unauthorized' || status === 401
  ? '模型登录认证出现错误，请检查登录状态。'
  : agentCode === 'usageLimitExceeded' || status === 429
    ? '模型服务报告额度或请求频率限制，请检查账号额度。'
    : ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(agentCode)
      ? '模型服务连接异常或中断，当前请求可能仍在重试。请检查服务器网络；详细分类已记入诊断。'
      : '模型服务报告错误，当前请求可能仍在重试。详细分类已记入诊断。';

// Service diagnostics are delivered separately from conversation replies.
// Never use the reply/error-report path here: a failed notification must not recurse.
export class AdminNotifications {
  constructor(controller, delivery) {
    Object.assign(this, { controller, delivery });
    this.seen = new Map();
  }
  async send({ scope = 'system', text, requestId, reason = 'SERVICE_ERROR', feedback, agentCode, upstreamStatus, buttons, beforeSend = async () => {}, isActive = () => true }) {
    const c = this.controller;
    try {
      if (c.closed || !isActive()) return;
      const group = scope.startsWith('group:') ? await c.groupAccess.read(scopeId(scope)) : null;
      const feedbackEnabled = async () => {
        if (c.closed || !isActive()) return false;
        if (!feedback) return true;
        if (scope.startsWith('group:')) {
          const current = await c.groupAccess.read(scopeId(scope));
          return !!current?.allowed && !!current.listen && !!current.engage && !current.taskBlocked && !current.leftAt
            && current.toolMonitor === true;
        }
        if (!scope.startsWith('c2c:') || !c.admins.includes(scope.slice(4))) return false;
        return (await c.adminSettings.read(scope)).toolMonitor === true;
      };
      if (!await feedbackEnabled()) return;
      if (!feedback && requestId) {
        const key = `${scope}:${requestId}:${reason}`;
        const previous = this.seen.get(key);
        if (previous !== undefined) return;
        this.seen.set(key, Date.now());
        if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
      }
      const origin = reason === 'WEB_DOMAIN_APPROVAL' ? '网页访问' : group ? groupLabel(group) : scope.startsWith('group:') ? `群 ${scopeId(scope).slice(0, 8)}`
        : scope.startsWith('c2c:') ? '私聊' : '服务';
      const body = redactCredentials(`【${feedback ? '运行反馈' : '服务提醒'} · ${origin}】\n${text || (reason === 'CODEX_UPSTREAM_ERROR' || reason.startsWith('CODEX_') && agentCode ? modelMessage(agentCode, upstreamStatus) : messageFor(reason))}`);
      const admins = [...new Set(c.admins)];
      if (!admins.length) c.debug.record(scope, 'admin_notification_failed', { requestId, reason: 'NO_BOT_ADMIN' });
      for (const openid of admins) {
        if (c.closed) return;
        try {
          const check = async () => {
            await beforeSend();
            if (!await feedbackEnabled()) throw new Error('FEEDBACK_DISABLED');
            if (!c.admins.includes(openid)) throw new Error('ADMIN_ACCESS_REVOKED');
          };
          await this.delivery.send(`c2c:${openid}`, body, { beforeSend: check, beforeCommit: check, isActive,
            plain: !buttons, notifyRateLimit: false });
          if (buttons) await this.delivery.send(`c2c:${openid}`, { text: '请发送对应指令，允许或拒绝网页访问：', buttons },
            { beforeSend: check, beforeCommit: check, isActive, notifyRateLimit: false });
          c.debug.record(scope, 'admin_notification_sent', { requestId, reason });
        } catch (error) {
          if (error.message === 'FEEDBACK_DISABLED' || error.message === 'REPLY_TURN_EXPIRED') continue;
          c.debug.record(scope, 'admin_notification_failed', { requestId, reason: 'ADMIN_NOTIFICATION_FAILED',
            ...this.delivery.diagnostics.errorDetails(error) });
        }
      }
    } catch {
      c.debug.record(scope, 'admin_notification_failed', { requestId, reason: 'ADMIN_NOTIFICATION_FAILED' });
    }
  }
}
