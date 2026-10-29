// Operator-side configuration transformation; never called by model tools.
export function snowGatewayConfig(config) {
  const copy = structuredClone(config);
  const pick = key => {
    const items = copy.networks?.[key]?.filter(item => item.enabled !== false);
    if (items?.length !== 1 || !items[0].accessToken?.trim()
      || !Number.isInteger(items[0].port) || items[0].port < 1 || items[0].port > 65535
      || ![undefined, '', '/'].includes(items[0].path)) throw new Error('SNOWLUMA_NETWORK_CONFIG_AMBIGUOUS');
    items[0].host = '0.0.0.0'; items[0].messageFormat = 'array'; items[0].reportSelfMessage = false;
    return items[0];
  };
  const http = pick('httpServers'), ws = pick('wsServers');
  ws.role = 'Universal';
  copy.statusCommand = { ...copy.statusCommand, enabled: false };
  return { config: copy, http: { port: http.port, token: http.accessToken }, ws: { port: ws.port, token: ws.accessToken } };
}
