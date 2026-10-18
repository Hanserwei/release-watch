import { AppError, type Env } from './env';
import type { SubscriptionInput, SubscriptionPatch, SubscriptionView } from '../shared/types';
import { iso, putSetting } from './db';
import { normalizeRepo, verifyRepository } from './github';
import { defaultCoverForRepo } from '../shared/covers';

const subscriptionSelect = `SELECT s.id, s.project_id AS projectId, p.repo, p.cover_url AS coverUrl,
 s.include_prerelease AS includePrerelease, s.interval_minutes AS intervalMinutes,
 s.paused, s.chat_id AS chatId, s.created_at AS createdAt,
 (SELECT tag FROM releases WHERE project_id=p.id AND (s.include_prerelease=1 OR prerelease=0) ORDER BY published_at DESC,id DESC LIMIT 1) AS latestTag,
 (SELECT url FROM releases WHERE project_id=p.id AND (s.include_prerelease=1 OR prerelease=0) ORDER BY published_at DESC,id DESC LIMIT 1) AS latestUrl,
 p.last_checked_at AS lastCheckedAt,p.last_success_at AS lastSuccessAt,p.next_check_at AS nextCheckAt,
 p.error,p.error_count AS errorCount,p.initialized
 FROM subscriptions s JOIN projects p ON p.id=s.project_id`;
export async function listSubscriptions(env: Env, chatId?: string): Promise<SubscriptionView[]> {
  const statement = chatId === undefined ? env.DB.prepare(`${subscriptionSelect} ORDER BY s.id DESC`) : env.DB.prepare(`${subscriptionSelect} WHERE s.chat_id=? ORDER BY s.id DESC`).bind(chatId);
  const { results } = await statement.all<SubscriptionView>();
  return results.map(row => ({ ...row, includePrerelease: Boolean(row.includePrerelease), paused: Boolean(row.paused), initialized: Boolean(row.initialized) }));
}
const builtinCoverPath = /^\/covers\/[a-z0-9-]+\.png$/;

/**
 * 校验项目封面：只接受内置静态图片路径或规范的 HTTPS 图片地址。
 * `null` 表示移除封面；返回规范化后的地址。
 */
export function normalizeCoverUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new AppError('封面地址必须为文本');
  const input = value.trim();
  if (!input) return null;
  if (input.length > 500) throw new AppError('封面地址过长，请使用更短的图片链接');
  // 空白与控制字符会破坏请求头与 Telegram 的 photo 参数。
  if (/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/.test(input)) throw new AppError('封面地址不能包含空白或控制字符');
  if (builtinCoverPath.test(input)) return input;
  if (!/^https:\/\//i.test(input)) throw new AppError('封面地址必须是以 https:// 开头的图片链接，或内置 /covers/ 图片');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('封面地址格式不正确');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new AppError('封面地址必须是不含凭据、端口与片段的 HTTPS 链接');
  if (!url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname === 'localhost') throw new AppError('封面地址必须是公开可访问的 HTTPS 域名');
  return url.href;
}
function validateOptions(input: SubscriptionPatch): void {
  if (input.intervalMinutes !== undefined && ![15, 30, 60, 360].includes(input.intervalMinutes)) throw new AppError('检查间隔请选择 15、30、60 或 360 分钟');
  if (input.includePrerelease !== undefined && typeof input.includePrerelease !== 'boolean') throw new AppError('预发布设置必须为布尔值');
  if (input.paused !== undefined && typeof input.paused !== 'boolean') throw new AppError('暂停设置必须为布尔值');
  if (input.coverUrl !== undefined) normalizeCoverUrl(input.coverUrl);
}
export async function addSubscription(env: Env, input: SubscriptionInput): Promise<SubscriptionView> {
  const repo = normalizeRepo(input.repo);
  validateOptions(input);
  if (input.chatId !== undefined && input.chatId !== null && !/^-?\d+$/.test(input.chatId)) throw new AppError('Telegram 目标格式不正确');
  // 未指定封面时沿用内置封面，让新订阅也能得到合适的默认图片。
  const cover = input.coverUrl === undefined ? defaultCoverForRepo(repo) : normalizeCoverUrl(input.coverUrl);
  const existing = await env.DB.prepare('SELECT id FROM projects WHERE repo=?').bind(repo).first<{ id: number }>();
  const isPublic = existing ? null : await verifyRepository(env, repo);
  const now = iso();
  const target = input.chatId ?? null;
  // Resolve the default target inside the transaction, so /start and web creation cannot lose a binding.
  const saved = await env.DB.batch<{ id: number }>([
    // 重复订阅共用项目，只补齐缺失的封面，绝不覆盖管理员已保存的自定义封面。
    env.DB.prepare(`INSERT INTO projects(repo,created_at,next_check_at,is_public,visibility_checked_at,cover_url) VALUES(?,?,?,?,?,?)
      ON CONFLICT(repo) DO UPDATE SET cover_url=COALESCE(projects.cover_url,excluded.cover_url)`)
      .bind(repo, now, now, Number(isPublic ?? false), isPublic === null ? null : now, cover),
    env.DB.prepare(`INSERT INTO subscriptions(project_id,chat_id,include_prerelease,interval_minutes,created_at,notify_after)
      SELECT id,COALESCE(?,(SELECT value FROM settings WHERE key='default_chat_id'),?),?,?,?,? FROM projects WHERE repo=?
      ON CONFLICT DO UPDATE SET id=subscriptions.id RETURNING id`).bind(target, env.TELEGRAM_CHAT_ID ?? null, Number(input.includePrerelease ?? false), input.intervalMinutes ?? 15, now, now, repo),
    env.DB.prepare('UPDATE projects SET next_check_at=MIN(next_check_at,?) WHERE repo=?').bind(now, repo),
  ]);
  const subscriptions = await listSubscriptions(env);
  const result = subscriptions.find(s => s.id === saved[1].results[0]?.id);
  if (!result) throw new AppError('订阅保存失败，请重试', 503);
  return result;
}
export async function updateSubscription(env: Env, id: number, patch: SubscriptionPatch, chatId?: string): Promise<SubscriptionView> {
  validateOptions(patch);
  const current = (await listSubscriptions(env, chatId)).find(s => s.id === id);
  if (!current) throw new AppError('订阅不存在', 404);
  const now = iso();
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.includePrerelease !== undefined) {
    assignments.push('include_prerelease=?');
    values.push(Number(patch.includePrerelease));
  }
  if (patch.intervalMinutes !== undefined) {
    assignments.push('interval_minutes=?');
    values.push(patch.intervalMinutes);
  }
  if (patch.paused !== undefined) {
    // SQLite evaluates every RHS against the actual old row in this statement.
    assignments.push('notify_after=CASE WHEN paused=1 AND ?=0 THEN ? ELSE notify_after END', 'paused=?');
    values.push(Number(patch.paused), now, Number(patch.paused));
  }
  const scope = 'id=? AND (? IS NULL OR chat_id=?)';
  const statements = [env.DB.prepare(`UPDATE subscriptions SET ${assignments.length ? assignments.join(',') : 'id=id'} WHERE ${scope} RETURNING id`)
    .bind(...values, id, chatId ?? null, chatId ?? null),
    env.DB.prepare(`UPDATE projects SET next_check_at=MIN(next_check_at,?) WHERE id=(SELECT project_id FROM subscriptions WHERE ${scope})`)
      .bind(now, id, chatId ?? null, chatId ?? null)];
  if (patch.paused === true) statements.push(env.DB.prepare(`DELETE FROM deliveries WHERE status!='sent'
    AND EXISTS(SELECT 1 FROM subscriptions s JOIN releases r ON r.project_id=s.project_id
      WHERE s.id=? AND (? IS NULL OR s.chat_id=?) AND s.paused=1
      AND r.id=deliveries.release_id AND s.chat_id=deliveries.chat_id)`).bind(id, chatId ?? null, chatId ?? null));
  if (patch.coverUrl !== undefined) {
    // 封面属于项目：同一仓库的多个订阅共享同一张图片。
    statements.push(env.DB.prepare(`UPDATE projects SET cover_url=? WHERE id=(SELECT project_id FROM subscriptions WHERE ${scope})`)
      .bind(normalizeCoverUrl(patch.coverUrl), id, chatId ?? null, chatId ?? null));
  }
  const updated = await env.DB.batch(statements);
  if (!updated[0].results.length) throw new AppError('订阅不存在', 404);
  return (await listSubscriptions(env, chatId)).find(s => s.id === id)!;
}
export async function removeSubscription(env: Env, id: number, chatId?: string): Promise<void> {
  const current = (await listSubscriptions(env, chatId)).find(s => s.id === id);
  if (!current) throw new AppError('订阅不存在', 404);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM deliveries WHERE status!='sent'
      AND EXISTS(SELECT 1 FROM subscriptions s JOIN releases r ON r.project_id=s.project_id
        WHERE s.id=? AND (? IS NULL OR s.chat_id=?)
        AND r.id=deliveries.release_id AND s.chat_id=deliveries.chat_id)`).bind(id, chatId ?? null, chatId ?? null),
    env.DB.prepare('DELETE FROM subscriptions WHERE id=? AND (? IS NULL OR chat_id=?)').bind(id, chatId ?? null, chatId ?? null),
  ]);
}
export async function bindDefaultChat(env: Env, chatId: string): Promise<void> {
  if (!/^-?\d+$/.test(chatId)) throw new AppError('Telegram 目标格式不正确');
  await env.DB.batch([
    putSetting(env, 'default_chat_id', chatId),
    env.DB.prepare('DELETE FROM subscriptions WHERE chat_id IS NULL AND project_id IN (SELECT project_id FROM subscriptions WHERE chat_id=?)').bind(chatId),
    env.DB.prepare('UPDATE subscriptions SET chat_id=? WHERE chat_id IS NULL').bind(chatId),
    // Releases discovered after web subscription but before binding remain eligible.
    env.DB.prepare(`INSERT INTO deliveries(release_id,chat_id,created_at)
      SELECT r.id,s.chat_id,? FROM releases r JOIN subscriptions s ON s.project_id=r.project_id
      WHERE s.chat_id=? AND s.paused=0 AND r.notify_at>=s.notify_after AND (r.prerelease=0 OR s.include_prerelease=1)
      AND NOT EXISTS(SELECT 1 FROM subscription_release_skips k WHERE k.subscription_id=s.id AND k.release_id=r.id)
      ON CONFLICT(chat_id,release_id) DO NOTHING`).bind(iso(), chatId),
  ]);
}
