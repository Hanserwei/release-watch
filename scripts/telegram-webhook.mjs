import { existsSync } from 'node:fs';
if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const urlArg = process.argv.findIndex(arg => arg === '--url');
const origin = urlArg >= 0 ? process.argv[urlArg + 1] : process.env.APP_URL;
if (!token || !secret || !/^[A-Za-z0-9_-]{24,256}$/.test(secret) || !origin) {
  console.error('请配置 TELEGRAM_BOT_TOKEN、24 到 256 位字母数字下划线连字符的 TELEGRAM_WEBHOOK_SECRET，并通过 --url 提供已部署的 HTTPS 地址。');
  process.exit(1);
}
let target;
try {
  target = new URL(origin);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error();
} catch { console.error('--url 必须是站点的 HTTPS 根地址'); process.exit(1); }
try {
  const response = await fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: new URL('/telegram/webhook', target).href, secret_token: secret, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error();
  console.log('Telegram Webhook 已设置。请使用允许的 Telegram 账户向机器人发送 /start。');
} catch { console.error('设置 Webhook 失败，请检查机器人凭据、网络和部署地址。'); process.exit(1); }
