import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const names = ['ADMIN_TOKEN', 'GITHUB_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_ALLOWED_USER_ID'];
const missing = names.filter(name => !process.env[name]?.trim());
if (missing.length) {
  console.error('请先填写配置项：' + missing.join('、'));
  process.exit(1);
}
if (process.env.ADMIN_TOKEN.length < 24 || !/^[A-Za-z0-9_-]{24,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET) || !/^[1-9]\d*$/.test(process.env.TELEGRAM_ALLOWED_USER_ID)) {
  console.error('管理口令至少 24 位；Webhook 密钥须为 24 到 256 位字母数字下划线连字符；Telegram 用户 ID 须为正整数。');
  process.exit(1);
}
const secrets = Object.fromEntries(names.map(name => [name, process.env[name]]));
if (process.env.TELEGRAM_CHAT_ID?.trim()) secrets.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// DeepSeek 密钥可选：留空则完全由管理界面配置，上传时只校验格式，绝不回显内容。
const deepseek = process.env.DEEPSEEK_API_KEY?.trim();
if (deepseek && !/^[\x21-\x7e]{20,200}$/.test(deepseek)) {
  console.error('DEEPSEEK_API_KEY 须为 20 到 200 位可见 ASCII 字符（不含空格与控制字符），或留空改为在管理界面配置。');
  process.exit(1);
}
if (deepseek) secrets.DEEPSEEK_API_KEY = deepseek;
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], {
  input: JSON.stringify(secrets), encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'],
});
process.exit(result.status ?? 1);
