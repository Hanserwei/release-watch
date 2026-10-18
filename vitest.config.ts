import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: { ADMIN_TOKEN: 'test-admin-token-at-least-24-characters', GITHUB_TOKEN: 'test-github-token', TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret', TELEGRAM_ALLOWED_USER_ID: '12345', TELEGRAM_CHAT_ID: '12345' } } })], test: { include: ['tests/**/*.test.ts'] } });
