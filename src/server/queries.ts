import type { ReleaseView, StatusData } from '../shared/types';
import type { Env } from './env';
import { setting } from './db';

export async function listReleases(env: Env, limit = 50, chatId?: string): Promise<ReleaseView[]> {
  const count = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const { results } = await env.DB.prepare(`SELECT r.id,r.project_id AS projectId,p.repo,r.tag,r.name,r.url,r.body,
    r.prerelease,r.published_at AS publishedAt,r.discovered_at AS discoveredAt,
    (SELECT d.status FROM deliveries d WHERE d.release_id=r.id AND (? IS NULL OR d.chat_id=?)
     ORDER BY CASE d.status WHEN 'failed' THEN 0 WHEN 'sending' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,d.id DESC LIMIT 1) AS deliveryStatus
    FROM releases r JOIN projects p ON p.id=r.project_id
    WHERE (? IS NULL OR EXISTS(SELECT 1 FROM subscriptions s WHERE s.project_id=p.id AND s.chat_id=?))
    ORDER BY r.published_at DESC,r.id DESC LIMIT ?`).bind(chatId ?? null, chatId ?? null, chatId ?? null, chatId ?? null, count).all<ReleaseView>();
  return results.map(row => ({ ...row, prerelease: Boolean(row.prerelease) }));
}
export async function retryFailedDeliveries(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE deliveries SET status='pending',attempts=0,next_attempt_at=0,lease_token=NULL,lease_until=0 WHERE status='failed'").run();
}
export async function getStatus(env: Env): Promise<StatusData> {
  const [counts, defaultChatId, lastCronAt, lastDeliveryAt] = await Promise.all([
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM deliveries WHERE status IN ('pending','sending')) AS pendingDeliveries,
      (SELECT COUNT(*) FROM deliveries WHERE status='failed') AS failedDeliveries,
      (SELECT COUNT(*) FROM deliveries WHERE status='sent') AS sentDeliveries,
      (SELECT COUNT(*) FROM projects) AS projectCount,
      (SELECT COUNT(*) FROM subscriptions WHERE paused=0) AS activeSubscriptions,
      (SELECT COUNT(*) FROM projects WHERE error IS NOT NULL) AS errorProjects,
      COALESCE((SELECT MIN(interval_minutes) FROM subscriptions WHERE paused=0),15) AS intervalMinutes`).first<Pick<StatusData, 'pendingDeliveries' | 'failedDeliveries' | 'sentDeliveries' | 'projectCount' | 'activeSubscriptions' | 'errorProjects' | 'intervalMinutes'>>(),
    setting(env, 'default_chat_id'), setting(env, 'last_cron_at'), setting(env, 'last_delivery_at'),
  ]);
  const chat = defaultChatId ?? env.TELEGRAM_CHAT_ID ?? null;
  return { githubConfigured: Boolean(env.GITHUB_TOKEN), telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN), telegramBound: Boolean(chat),
    webhookConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_ALLOWED_USER_ID),
    lastCronAt, lastDeliveryAt, defaultChatId: chat,
    pendingDeliveries: counts?.pendingDeliveries ?? 0, failedDeliveries: counts?.failedDeliveries ?? 0,
    sentDeliveries: counts?.sentDeliveries ?? 0, projectCount: counts?.projectCount ?? 0,
    activeSubscriptions: counts?.activeSubscriptions ?? 0, errorProjects: counts?.errorProjects ?? 0,
    intervalMinutes: counts?.intervalMinutes ?? 15 };
}
