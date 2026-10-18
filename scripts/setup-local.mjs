import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
if (!existsSync('.dev.vars')) {
  const template = readFileSync('.dev.vars.example', 'utf8');
  writeFileSync('.dev.vars', template.replace(/^ADMIN_TOKEN=""$/m, 'ADMIN_TOKEN="' + randomBytes(24).toString('base64url') + '"'), { mode: 0o600 });
  console.log('已生成本地配置。管理访问口令位于 .dev.vars 的 ADMIN_TOKEN，文件不会提交到 Git。');
}
const localConfig = readFileSync('.dev.vars', 'utf8');
if (/^TELEGRAM_WEBHOOK_SECRET=""$/m.test(localConfig)) {
  writeFileSync('.dev.vars', localConfig.replace(/^TELEGRAM_WEBHOOK_SECRET=""$/m, 'TELEGRAM_WEBHOOK_SECRET="' + randomBytes(24).toString('base64url') + '"'), { mode: 0o600 });
  console.log('已生成独立的 Telegram Webhook 验证密钥。');
}
// 旧的本地配置缺少后续新增的可选配置项时补齐空行，避免读取时把它当成未定义。
const current = readFileSync('.dev.vars', 'utf8');
const optionalKeys = ['DEEPSEEK_API_KEY', 'TELEGRAM_CHAT_ID'];
const missing = optionalKeys.filter(key => !new RegExp(`^${key}=`, 'm').test(current));
if (missing.length) {
  writeFileSync('.dev.vars', current.replace(/\n?$/, '\n') + missing.map(key => `${key}=""`).join('\n') + '\n', { mode: 0o600 });
  console.log('已补充可选配置项：' + missing.join('、') + '（留空表示未配置）。');
}
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
