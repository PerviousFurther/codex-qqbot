import { callReplyBridge } from './reply-bridge.mjs';
import { approvalHost } from './web-access-state.mjs';
import { assertMessageAccess } from './message-access.mjs';

// Private token-bound IPC; the model can neither approve a host nor edit policy.
export class WebDomainClient {
  constructor({ eventSocket, scope, store }) { Object.assign(this, { eventSocket, scope, store }); }
  async check(turnId) {
    const result = await callReplyBridge(this.eventSocket, { action: 'media_check', turn_id: turnId }, { timeoutMs: 5000 });
    if (!result.ok) throw new Error(result.code);
  }
  async request(host, turnId, signal) {
    try {
      approvalHost(host);
      await assertMessageAccess(this.scope, this.store);
      const result = await callReplyBridge(this.eventSocket, { action: 'web_domain_request', turn_id: turnId, host }, { timeoutMs: 15000, signal });
      if (!result.ok) return 'unavailable';
      return ['pending', 'approved', 'denied', 'full', 'limited'].includes(result.status) ? result.status : 'unavailable';
    } catch { return 'unavailable'; }
  }
}
