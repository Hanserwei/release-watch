export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
  DEEPSEEK_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ALLOWED_USER_ID?: string;
  TELEGRAM_CHAT_ID?: string;
  POLL_BATCH_SIZE?: string;
  DELIVERY_BATCH_SIZE?: string;
}

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'AppError'; }
}
