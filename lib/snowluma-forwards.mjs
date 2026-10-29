import { snowForwardMessage } from './snowluma-messages.mjs';
import { snowRecipient } from './snowluma-identity.mjs';

// Only an explicit, turn-authorized detail read may acquire this opaque leaf.
// Event capture, previews and direct-child paging never call the gateway.
export class SnowLumaForwards {
  constructor(channel) { this.channel = channel; }
  async read(scope, id, checkAccess, signal) {
    if (!/^forward:[a-f0-9]{32}$/.test(id)) throw new Error('FORWARD_REFERENCE_INVALID');
    const channel = this.channel, records = channel.controller.messageRecords;
    snowRecipient(channel.account, scope.slice(scope.indexOf(':') + 1));
    const generation = channel.generation;
    const connection = () => {
      if (signal?.aborted) throw new Error('CONTEXT_SOURCE_UNAVAILABLE');
      if (!channel.ready || !channel.accepting || channel.stopped || generation !== channel.generation)
        throw new Error('SNOWLUMA_CONNECTION_UNAVAILABLE');
    };
    const check = async () => {
      connection();
      await checkAccess();
      connection();
    };
    await check();
    const reference = await records.forwardReference(scope, id);
    if (!reference) throw new Error('FORWARD_REFERENCE_UNAVAILABLE');
    const retained = async () => {
      await check();
      const current = await records.forwardReference(scope, id);
      if (!current || current.message_id !== reference.message_id || current.received !== reference.received
        || current.resource_id !== reference.resource_id) throw new Error('MESSAGE_NOT_RETAINED');
    };
    await retained();
    if (await records.find(scope, id)) { await retained(); return { acquired: false }; }
    let result;
    try {
      result = await channel.client.getForwardMessage({ id: reference.resource_id }, { signal, timeoutMs: 15000 });
    } catch {
      await retained();
      throw new Error('FORWARD_ACQUISITION_FAILED');
    }
    await retained();
    const message = await snowForwardMessage(result, channel.account, scope.startsWith('group:') ? 'group' : 'c2c', id);
    await retained();
    await records.capture(scope, message, null, !!reference.historical,
      { received: reference.received, assertAccess: retained, forwardReference: reference });
    await retained();
    return { acquired: true };
  }
}
