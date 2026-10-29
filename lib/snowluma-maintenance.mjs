import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';

// Filesystem permissions restrict this socket to the service UID and host root.
// It is not exposed through MCP, TCP, QQ commands or a mounted Docker socket.
export async function serveSnowMaintenance(path, drain) {
  const existing = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isSocket()) throw new Error('SNOWLUMA_CONTROL_PATH_INVALID');
    const live = await new Promise((resolve, reject) => {
      const probe = net.connect(path);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
    });
    if (live) throw new Error('SNOWLUMA_CONTROL_ALREADY_RUNNING');
    await unlink(path);
  }
  const peers = new Set();
  let tail = Promise.resolve();
  const server = net.createServer(socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(5000, () => socket.destroy());
    let body = '', submitted = false;
    socket.on('data', chunk => {
      if (submitted) return;
      body += chunk.toString('utf8');
      if (body.length > 1024) { socket.destroy(); return; }
      if (!body.includes('\n')) return;
      submitted = true;
      tail = tail.then(async () => {
        try { socket.end(JSON.stringify(await drain.command(JSON.parse(body))) + '\n'); }
        catch { socket.end('{"status":"failed"}\n'); }
      }).catch(() => {});
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  const timer = setInterval(() => { tail = tail.then(() => drain.expire()).catch(() => {}); }, 10000);
  timer.unref();
  return async () => {
    clearInterval(timer); for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve)); await tail;
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
}

export function callSnowMaintenance(path, command) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path); let body = '';
    socket.setTimeout(20000, () => socket.destroy(new Error('SNOWLUMA_CONTROL_TIMEOUT')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', chunk => { body += chunk; if (body.length > 1024) socket.destroy(new Error('SNOWLUMA_CONTROL_INVALID')); });
    socket.once('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('SNOWLUMA_CONTROL_INVALID')); } });
  });
}
