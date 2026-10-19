import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = readFileSync('wrangler.jsonc', 'utf8');
const id = config.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
if (!id || id === '00000000-0000-0000-0000-000000000000') {
  console.error('请先运行 pnpm exec wrangler d1 create release-watch，并把返回的 database_id 填入 wrangler.jsonc。');
  process.exit(1);
}
const args = ['node_modules/wrangler/bin/wrangler.js'];
const migration = spawnSync(process.execPath, [...args, 'd1', 'migrations', 'apply', 'DB', '--remote'], { stdio: 'inherit' });
if (migration.status !== 0) process.exit(migration.status ?? 1);
const deploy = spawnSync(process.execPath, [...args, 'deploy'], { stdio: 'inherit' });
process.exit(deploy.status ?? 1);
