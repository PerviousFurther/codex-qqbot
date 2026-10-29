import { deliveryRateLimitDetails } from '../delivery-errors.mjs';
import '../mcp-codecs.mjs';
import { imageLimitDetails } from '../image-policy.mjs';
import { contentCodecs } from '../content-codecs.mjs';

export function toolFailure(error, recovery = '说明工具错误码，不编造原因或绕过权限。') {
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message) ? error.message
    : /^[A-Z][A-Z0-9_]{2,79}$/.test(error.code ?? '') ? error.code : 'TOOL_FAILED';
  return { isError: true, content: [contentCodecs.value('json', { ok: false, code, recovery, ...imageLimitDetails(error), ...deliveryRateLimitDetails(error) })] };
}

// Only this endpoint turns typed flows into MCP blocks; handlers remain reusable.
async function encodeResult(result) {
  const content = [];
  for (const stream of result.content) {
    for await (const blocks of stream.to('mcp.content')) content.push(...blocks);
  }
  return { ...result, content };
}

// Tool modules own error recovery; the shared boundary enforces the explicit allowlist.
export function toolRegistrar(server, policy) {
  return function register(name, description, inputSchema, action, failure = toolFailure) {
    if (!Object.hasOwn(policy, name)) throw new Error('TOOL_POLICY_REQUIRED');
    server.registerTool(name, { description, inputSchema, annotations: policy[name] }, async (args, extra = {}) => {
      try { return await encodeResult({ content: await action(args, extra) }); }
      catch (error) { return encodeResult(await failure(error)); }
    });
  };
}
