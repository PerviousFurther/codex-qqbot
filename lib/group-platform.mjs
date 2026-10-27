import { SerialQueue } from './serial-queue.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Official QQ metadata is separate from local authorization and observed delivery.
export const groupLabel = group => String(group.remark || group.name || `群 ${group.id.slice(0, 8)}`)
  .replace(/[\x00-\x1f\x7f\\`*_#<>\[\]()~]/g, ' ').trim().slice(0, 60);

const modes = {
  all: 'QQ 当前设置为接收全部群消息。',
  only_mention: 'QQ 当前只接收 @ 消息。要使用自动接话，请在群里的机器人设置中允许接收全部消息。',
  mention_and_context: 'QQ 当前只接收 @ 及相关消息，自动接话可能无法了解完整讨论。',
};

export function groupReception(group) {
  const result = group.platform?.state;
  if (!result || result.error) return '暂时无法确认群消息接收范围。如自动接话无效，请在 QQ 中检查机器人的接收设置。';
  return modes[result.value.recv_msg_setting] ?? '请在 QQ 的群机器人设置中确认消息接收范围。';
}

export class GroupPlatform {
  constructor({ groups, query, formatError, record }) {
    Object.assign(this, { groups, query, formatError, record });
    this.pending = new Map(); this.requests = new Map(); this.lastRequest = new Map();
  }
  async refresh(group, { force = false } = {}) {
    if (this.pending.has(group.id)) return this.pending.get(group.id);
    const task = this.load(group.id, force);
    this.pending.set(group.id, task);
    try { return await task; } finally { this.pending.delete(group.id); }
  }
  request(openid, endpoint) {
    // Each endpoint is limited to 30 QPM across all groups, not per group.
    if (!this.requests.has(endpoint)) this.requests.set(endpoint, new SerialQueue());
    return this.requests.get(endpoint).run(async () => {
      const wait = 2100 - (Date.now() - (this.lastRequest.get(endpoint) ?? 0));
      if (wait > 0) await delay(wait);
      this.lastRequest.set(endpoint, Date.now());
      return this.query(openid, endpoint);
    });
  }
  async load(id, force) {
    const group = await this.groups.read(id);
    // Persist caches across restarts; a manual refresh has a 30-second cooldown.
    const ttl = force ? 30000 : 10 * 60000;
    const kinds = ['info', 'state'].filter(kind => !group.platform?.[kind]
      || Date.now() - group.platform[kind].checkedAt >= ttl);
    const results = await Promise.all(kinds.map(async kind => {
      const checkedAt = Date.now();
      try {
        const response = await this.request(group.openid, kind === 'info' ? 'info' : 'bot_state');
        if (!response || (kind === 'info' ? typeof response.group_name !== 'string'
          : typeof response.recv_msg_setting !== 'string')) throw new Error('INVALID_QQ_GROUP_RESPONSE');
        const value = kind === 'info' ? { group_name: response.group_name.slice(0, 100) }
          : { recv_msg_setting: response.recv_msg_setting.slice(0, 80) };
        return [kind, { checkedAt, value }];
      } catch (error) {
        const hint = Number(error.bizCode) === 11253 ? '接口仅白名单机器人可用，请联系平台申请权限。' : '';
        this.record(group, error);
        return [kind, { checkedAt, error: [hint, this.formatError(error)].filter(Boolean).join('\n') }];
      }
    }));
    if (!results.length) return group;
    return this.groups.update(id, current => {
      current.platform = { ...current.platform, ...Object.fromEntries(results) };
      const name = current.platform.info?.value?.group_name;
      if (name !== undefined) current.name = name;
    });
  }
}
