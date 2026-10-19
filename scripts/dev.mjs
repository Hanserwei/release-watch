import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

if (!existsSync('.dev.vars')) {
  console.error('请先运行 pnpm setup:local，生成本地口令并初始化数据库。');
  process.exit(1);
}
if (!existsSync('dist/index.html')) {
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const children = [
  spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--port', '8787', '--test-scheduled'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' }),
];
let stopping = false;
let tickRunning = false;
async function tick() {
  if (stopping || tickRunning) return;
  tickRunning = true;
  try {
    const response = await fetch('http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*&format=json', { signal: AbortSignal.timeout(50_000) });
    const result = await response.json();
    if (!response.ok || result.outcome !== 'ok') console.error('本地定时检查未完成，将在下一分钟重试。');
  } catch { if (!stopping) console.error('本地检查服务暂未就绪，将在下一分钟重试。'); }
  finally { tickRunning = false; }
}
const firstTick = setTimeout(() => void tick(), 3000);
const ticker = setInterval(() => void tick(), 60_000);
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(firstTick);
  clearInterval(ticker);
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
