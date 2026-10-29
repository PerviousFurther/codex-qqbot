// Explicit operator migration setup. Writes only gateway connection settings
// and the ignored project .env; never starts/restarts services or reads chats.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from '../lib/store.mjs';
import { qqId } from '../lib/snowluma-identity.mjs';
import { snowGatewayConfig } from '../lib/snowluma-config.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--admin') throw new Error('USAGE_CONFIGURE_SNOWLUMA_ADMIN_QQS');
  const admins = [...new Set(args[1].split(',').map(qqId))];
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = join(project, '.env');
  let env; try { env = await readFile(envPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; env = ''; }
  const script = `
    import fs from 'node:fs';
    const transform = ${snowGatewayConfig.toString()};
    try {
      const dir='/app/data/config';
      const names=fs.readdirSync(dir).filter(n=>/^onebot_\\d+\\.json$/.test(n));
      if(names.length!==1)throw new Error('SNOWLUMA_SINGLE_ACCOUNT_REQUIRED');
      const account=names[0].slice(7,-5);
      if(${JSON.stringify(admins)}.includes(account))throw new Error('SNOWLUMA_ADMIN_MUST_BE_SEPARATE_ACCOUNT');
      const plan=['onebot.json',names[0]].map(name=>({path:dir+'/'+name,...transform(JSON.parse(fs.readFileSync(dir+'/'+name,'utf8')))}));
      for(const item of plan){
        const stat=fs.statSync(item.path), tmp=item.path+'.migration-'+process.pid;
        const fd=fs.openSync(tmp,'wx',0o600);
        try{fs.writeFileSync(fd,JSON.stringify(item.config,null,2)+'\\n');fs.fchownSync(fd,stat.uid,stat.gid);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.renameSync(tmp,item.path);
      }
      process.stdout.write(JSON.stringify({account,http:plan[1].http,ws:plan[1].ws}));
    } catch { process.exitCode=1; }
  `;
  const child = spawnSync('docker', ['exec', '-i', 'llm-watch-video-snowluma-1', 'node', '--input-type=module'],
    { input: script, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  if (child.status !== 0) throw new Error('SNOWLUMA_CONFIGURE_FAILED');
  const config = JSON.parse(child.stdout); const account = qqId(config.account);
  const values = { SNOWLUMA_ACCOUNT_ID: account, SNOWLUMA_ADMIN_QQS: admins.join(','),
    SNOWLUMA_HTTP_URL: `http://snowluma:${config.http.port}/`, SNOWLUMA_WS_URL: `ws://snowluma:${config.ws.port}/`,
    SNOWLUMA_HTTP_TOKEN: config.http.token, SNOWLUMA_WS_TOKEN: config.ws.token };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_:/.,~+\-=]+$/.test(value)) throw new Error('SNOWLUMA_CONFIG_VALUE_INVALID');
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    env = pattern.test(env) ? env.replace(pattern, () => line) : `${env.trimEnd()}\n${line}\n`;
  }
  await writeAtomic(envPath, env);
  console.log('SnowLuma connection and explicit administrator binding saved. Tokens were not printed. Apply the Compose commands in HANDOFF.md; no service was restarted.');
} catch (error) {
  const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message ?? '') ? error.message : 'SNOWLUMA_CONFIGURE_FAILED';
  console.error(reason); process.exitCode = 1;
}
