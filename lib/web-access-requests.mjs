import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SerialQueue } from './serial-queue.mjs';
import { approvalHost, webAccessState } from './web-access-state.mjs';
import { assertAllowedWebDomain, assertNonAdultWebDomain } from './web-access-policy.mjs';
import { action, interaction } from './interaction.mjs';

const back = action('返回网页权限', '/web-access');
const browsing = action('返回浏览设置', '/settings browsing');

// The main service is the sole writer. Records contain hosts/tokens/statuses only,
// never source identities, URLs, page bodies or model-provided descriptions.
export class WebAccessRequests {
  constructor(controller, now = Date.now) {
    this.controller = controller; this.store = controller.store; this.now = now;
    this.queue = new SerialQueue(); this.path = join(this.store.root, 'web-access.json');
  }
  async read() { return webAccessState(await this.store.read(this.path, null)); }
  async save(state) {
    webAccessState(state);
    if (Buffer.byteLength(JSON.stringify(state, null, 2) + '\n') > 65536) throw new Error('WEB_ACCESS_STATE_LIMIT');
    await this.store.write(this.path, state);
  }
  checkAdmin(scope) {
    if (this.controller.closed || !scope.startsWith('c2c:') || !this.controller.admins.includes(scope.slice(4))) throw new Error('ADMIN_ACCESS_REVOKED');
  }
  async request(host, { scope, isActive, checkAccess }) {
    approvalHost(host); assertNonAdultWebDomain(new URL(`https://${host}`));
    const result = await this.queue.run(async () => {
      await checkAccess();
      const state = await this.read();
      if (state.approved.includes(host)) return { status: 'approved' };
      try { assertAllowedWebDomain(new URL(`https://${host}`)); return { status: 'approved' }; }
      catch (error) { if (error.message !== 'WEB_DOMAIN_NOT_ALLOWED') throw error; }
      const existing = state.requests.find(item => item.host === host && item.expiresAt > this.now());
      if (existing) return { status: existing.status };
      state.requests = state.requests.filter(item => item.expiresAt > this.now());
      if (state.requests.length >= 100) return { status: 'full' };
      const record = { id: randomBytes(16).toString('hex'), host, status: 'pending', expiresAt: this.now() + 600000 };
      state.requests.push(record);
      await checkAccess();
      await this.save(state);
      return { status: 'pending', record };
    });
    if (result.record) {
      const { record } = result;
      await this.controller.notifyAdmins({ scope, requestId: record.id, reason: 'WEB_DOMAIN_APPROVAL', isActive,
        beforeSend: async () => {
          await checkAccess();
          const current = (await this.read()).requests.find(item => item.id === record.id);
          if (current?.status !== 'pending' || current.expiresAt <= this.now()) throw new Error('WEB_APPROVAL_EXPIRED');
        },
        text: this.detail(record), buttons: this.buttons(record),
      });
    }
    return { status: result.status };
  }
  detail(record) {
    return `## 网页访问审批\n主机：${record.host}\n\n允许后，所有已获准的对话都可访问这一主机，不包含它的子域名。公网地址和内容限制仍然适用。\n申请十分钟内有效；批准不会自动重试之前的访问、点击或提交，也不会恢复已停止的任务。`;
  }
  buttons(record) {
    return { rows: [[action('允许此主机', `/web-access allow ${record.id}`), action('拒绝', `/web-access deny ${record.id}`)], [back]], prompt: '请选择网页访问权限：' };
  }
  async handle(scope, command) {
    this.checkAdmin(scope);
    const decision = /^\/web-access (allow|deny) ([a-f0-9]{32})$/.exec(command);
    const remove = /^\/web-access remove ([a-z0-9.-]{1,253})$/.exec(command);
    if (decision || remove) {
      return this.queue.run(async () => {
        this.checkAdmin(scope);
        const state = await this.read();
        if (remove) {
          approvalHost(remove[1]);
          if (!state.approved.includes(remove[1])) return interaction('该主机没有额外授权；内置列表中的域名不在这里撤销。', [[back]]);
          state.approved = state.approved.filter(host => host !== remove[1]);
          this.checkAdmin(scope); await this.save(state);
          return interaction(`已撤销 ${remove[1]} 的额外授权，后续访问会重新检查。已提交的请求无法撤回。`, [[action('查看已允许主机', '/web-access allowed'), back]]);
        }
        const record = state.requests.find(item => item.id === decision[2] && item.status === 'pending' && item.expiresAt > this.now());
        if (!record) return interaction('该申请已处理或已过期，请查看当前待审批列表。', [[back]]);
        assertNonAdultWebDomain(new URL(`https://${record.host}`));
        if (decision[1] === 'allow') {
          if (state.approved.length >= 500) return interaction('额外授权列表已满，请先撤销不再需要的主机。', [[action('查看已允许主机', '/web-access allowed')]]);
          state.approved = [...new Set([...state.approved, record.host])].sort();
          state.requests = state.requests.filter(item => item.id !== record.id);
        } else { record.status = 'denied'; record.expiresAt = this.now() + 3600000; }
        this.checkAdmin(scope); await this.save(state);
        return interaction(decision[1] === 'allow' ? `已允许 ${record.host}，不包含子域名。后续新访问立即生效，不会自动重试之前的操作。`
          : `已拒绝 ${record.host}，一小时内不重复申请。`, [[back]]);
      });
    }
    await this.queue.idle;
    const state = await this.read(); this.checkAdmin(scope);
    const view = /^\/web-access view ([a-f0-9]{32})$/.exec(command);
    if (view) {
      const record = state.requests.find(item => item.id === view[1] && item.status === 'pending' && item.expiresAt > this.now());
      return record ? { text: this.detail(record), buttons: this.buttons(record) } : interaction('该申请已处理或已过期。', [[back]]);
    }
    const list = /^\/web-access(?: (allowed)(?: (\d+))?| (\d+))?$/.exec(command);
    if (!list) return interaction('请从网页权限页面选择操作。', [[back, browsing]]);
    const allowed = !!list[1], values = allowed ? state.approved : state.requests.filter(item => item.status === 'pending' && item.expiresAt > this.now());
    const pages = Math.max(1, Math.ceil(values.length / 4));
    const page = Math.min(pages, Math.max(1, Number(list[2] ?? list[3]) || 1));
    const items = values.slice((page - 1) * 4, page * 4);
    const rows = items.map(item => [allowed ? action(`撤销 ${item}`, `/web-access remove ${item}`) : action(`审批 ${item.host}`, `/web-access view ${item.id}`)]);
    const nav = [];
    const prefix = allowed ? '/web-access allowed' : '/web-access';
    if (page > 1) nav.push(action('上一页', `${prefix} ${page - 1}`));
    if (page < pages) nav.push(action('下一页', `${prefix} ${page + 1}`));
    nav.push(allowed ? back : action('已允许主机', '/web-access allowed'), browsing); rows.push(nav);
    return interaction(`## 网页权限 · ${allowed ? '已允许主机' : '待审批'}（${page}/${pages}）\n${items.map(item => allowed ? item : item.host).join('\n') || '暂无记录。'}\n\n额外授权对已获准的对话全局生效，仅匹配具体主机。批准不绕过成人域名或公网地址检查。`, rows);
  }
}
