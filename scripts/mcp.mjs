import { configureWebAccess } from '../lib/web-access-policy.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from '../lib/store.mjs';
import { createBotMcp } from '../lib/mcp.mjs';

process.umask(0o077);
const store = new Store(process.env.WATCH_DATA_DIR);
configureWebAccess(store.root);
const mcp = createBotMcp({ scope: process.env.WATCH_SCOPE ?? 'local', store,
  allowProjectFiles: process.env.WATCH_PROJECT_FILES === 'true', projectRoot: process.env.WATCH_PROJECT_ROOT,
  replySocket: process.env.WATCH_REPLY_SOCKET, eventSocket: process.env.WATCH_EVENT_SOCKET,
  audioConfig: { modelDir: process.env.WATCH_AUDIO_MODEL_DIR, vadModel: process.env.WATCH_AUDIO_VAD_MODEL,
    runtime: process.env.WATCH_AUDIO_RUNTIME_DIR, numThreads: Number(process.env.WATCH_AUDIO_THREADS ?? 2) } });
await mcp.server.connect(new StdioServerTransport());
let closing = false;
async function close() { if (!closing) { closing = true; await mcp.close(); } }
process.stdin.on('end', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
