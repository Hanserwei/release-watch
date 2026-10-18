import type { DeliverySummary } from '../shared/types';
import type { Env } from './env';
import { bounded, iso, retryDelay } from './db';
import { sendTelegramMessage, sendTelegramPhoto, TelegramError, TelegramPhotoError } from './telegram-client';
import { notificationChangelog } from './changelog';

interface Candidate { id: number; chat_id: string; }
interface Claimed { id: number; release_id: number; chat_id: string; attempts: number; }
const maxAttempts = 8;
const leaseDuration = 60_000;
const eligibleSubscription = `EXISTS(SELECT 1 FROM releases r JOIN subscriptions s ON s.project_id=r.project_id
  WHERE r.id=deliveries.release_id AND s.chat_id=deliveries.chat_id AND s.paused=0
    AND (r.prerelease=0 OR s.include_prerelease=1) AND r.notify_at>=s.notify_after
    AND NOT EXISTS(SELECT 1 FROM subscription_release_skips k WHERE k.subscription_id=s.id AND k.release_id=r.id))`;
export async function deliverPending(env: Env): Promise<DeliverySummary> {
  const summary: DeliverySummary = { sent: 0, failed: 0 };
  const start = Date.now();
  await env.DB.prepare(`DELETE FROM deliveries WHERE status!='sent' AND NOT ${eligibleSubscription}`).run();
  await env.DB.prepare(`UPDATE deliveries SET status='failed',lease_token=NULL,lease_until=0,error='发送尝试已达到上限，可手动重试'
    WHERE status='sending' AND lease_until<=? AND attempts>=?`).bind(start, maxAttempts).run();
  const { results } = await env.DB.prepare(`SELECT deliveries.id,deliveries.chat_id FROM deliveries
    LEFT JOIN chat_delivery_locks c ON c.chat_id=deliveries.chat_id
    WHERE ((deliveries.status='pending' AND deliveries.next_attempt_at<=?) OR (deliveries.status='sending' AND deliveries.lease_until<=?))
      AND deliveries.attempts<? AND COALESCE(c.next_send_at,0)<=? AND COALESCE(c.lease_until,0)<=?
      AND ${eligibleSubscription}
    ORDER BY deliveries.next_attempt_at,deliveries.id LIMIT ?`).bind(start, start, maxAttempts, start, start, bounded(env.DELIVERY_BATCH_SIZE, 1, 1)).all<Candidate>();
  const seenChats = new Set<string>();
  const batchSize = bounded(env.DELIVERY_BATCH_SIZE, 1, 1);
  let attempted = 0;
  for (const candidate of results) {
    if (attempted >= batchSize) break;
    if (seenChats.has(candidate.chat_id)) continue;
    seenChats.add(candidate.chat_id);
    const token = crypto.randomUUID();
    const now = Date.now();
    const batch = await env.DB.batch([
      env.DB.prepare(`INSERT INTO chat_delivery_locks(chat_id,next_send_at,lease_token,lease_until) VALUES(?,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET next_send_at=excluded.next_send_at,lease_token=excluded.lease_token,lease_until=excluded.lease_until
        WHERE chat_delivery_locks.next_send_at<=? AND chat_delivery_locks.lease_until<=?`).bind(candidate.chat_id, now + 1000, token, now + leaseDuration, now, now),
      env.DB.prepare(`UPDATE deliveries SET status='sending',attempts=attempts+1,lease_token=?,lease_until=?
        WHERE id=? AND attempts<? AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?))
        AND EXISTS(SELECT 1 FROM chat_delivery_locks WHERE chat_id=? AND lease_token=? AND lease_until>?)
        AND ${eligibleSubscription}
        RETURNING id,release_id,chat_id,attempts`).bind(token, now + leaseDuration, candidate.id, maxAttempts, now, now, candidate.chat_id, token, now),
    ]);
    const claimed = batch[1].results[0] as Claimed | undefined;
    if (!claimed) {
      await env.DB.prepare('UPDATE chat_delivery_locks SET lease_token=NULL,lease_until=0 WHERE chat_id=? AND lease_token=?').bind(candidate.chat_id, token).run();
      continue;
    }
    attempted++;
    let errorMessage: string | null = null;
    let delay = 1000;
    try {
      const release = await env.DB.prepare(`SELECT p.repo,p.cover_url,r.id,r.tag,r.name,r.url,r.prerelease,r.body,r.published_at,r.changelog_zh,
        deliveries.notification_text,deliveries.photo_message_id,deliveries.text_offset
        FROM deliveries JOIN releases r ON r.id=deliveries.release_id JOIN projects p ON p.id=r.project_id
        WHERE deliveries.id=? AND deliveries.status='sending' AND deliveries.lease_token=? AND ${eligibleSubscription}`)
        .bind(claimed.id, token).first<{
          id: number; repo: string; cover_url: string | null; tag: string; name: string; url: string; prerelease: number;
          body: string; published_at: string; changelog_zh: string | null; notification_text: string | null;
          photo_message_id: number | null; text_offset: number;
        }>();
      if (!release) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM deliveries WHERE id=? AND status='sending' AND lease_token=?").bind(claimed.id, token),
          env.DB.prepare('UPDATE chat_delivery_locks SET lease_token=NULL,lease_until=0 WHERE chat_id=? AND lease_token=?').bind(claimed.chat_id, token),
        ]);
        continue;
      }
      let text = release.notification_text;
      if (text === null) {
        const changelog = await notificationChangelog(env, release);
        text = `${release.repo} 发布${release.prerelease ? '预发布' : '新'}版本 ${release.tag}\n${release.name}\n发布时间：${release.published_at}\n${release.url}${changelog ? `\n\n${changelog}` : ''}`;
      }
      // Recheck eligibility after the optional model call, before making an external send.
      const prepared = await env.DB.prepare(`UPDATE deliveries SET notification_text=?
        WHERE id=? AND status='sending' AND lease_token=? AND ${eligibleSubscription} RETURNING id`)
        .bind(text, claimed.id, token).first<{ id: number }>();
      if (!prepared) {
        await env.DB.prepare('UPDATE chat_delivery_locks SET lease_token=NULL,lease_until=0 WHERE chat_id=? AND lease_token=?').bind(claimed.chat_id, token).run();
        continue;
      }
      let offset = release.text_offset;
      let photoId = release.photo_message_id;
      let messageId: number | null = null;
      if (release.cover_url && photoId === null && offset === 0) {
        const caption = text.slice(0, 1024).replace(/[\uD800-\uDBFF]$/, '');
        try {
          messageId = await sendTelegramPhoto(env, claimed.chat_id, caption, release.cover_url);
          photoId = messageId;
          offset = caption.length;
        } catch (error) {
          if (!(error instanceof TelegramPhotoError)) throw error;
        }
      }
      if (messageId === null) {
        const chunk = text.slice(offset, offset + 4000).replace(/[\uD800-\uDBFF]$/, '');
        messageId = await sendTelegramMessage(env, claimed.chat_id, chunk);
        offset += chunk.length;
      }
      // One successful send per chat per invocation. Persist the exact text and offset so
      // long original changelogs resume without sending the cover or earlier chunks again.
      const complete = offset >= text.length;
      const sentAt = iso();
      const saved = await env.DB.batch([
        env.DB.prepare(`UPDATE deliveries SET status=?,sent_at=?,message_id=?,error=NULL,lease_token=NULL,lease_until=0,
          photo_message_id=?,text_offset=?,attempts=CASE WHEN ? THEN attempts ELSE 0 END,next_attempt_at=?
          WHERE id=? AND status='sending' AND lease_token=?`).bind(complete ? 'sent' : 'pending', complete ? sentAt : null,
            photoId ?? messageId, photoId, offset, complete ? 1 : 0, Date.now() + 1000, claimed.id, token),
        env.DB.prepare(`INSERT INTO settings(key,value) SELECT 'last_delivery_at',? WHERE EXISTS(SELECT 1 FROM deliveries WHERE id=? AND status='sent' AND message_id=?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(sentAt, claimed.id, photoId ?? messageId),
        env.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=?,lease_token=NULL,lease_until=0 WHERE chat_id=? AND lease_token=?').bind(Date.now() + 1000, claimed.chat_id, token),
      ]);
      if (complete && saved[0].meta.changes) summary.sent++;
    } catch (error) {
      errorMessage = error instanceof TelegramError ? error.message : '通知发送暂时失败，稍后自动重试';
      delay = Math.max(1000, retryDelay(claimed.attempts), error instanceof TelegramError ? (error.retryAfter ?? 0) * 1000 : 0);
      const terminal = claimed.attempts >= maxAttempts || (error instanceof TelegramError && error.permanent);
      await env.DB.batch([
        env.DB.prepare(`UPDATE deliveries SET status=?,error=?,next_attempt_at=?,lease_token=NULL,lease_until=0
          WHERE id=? AND status='sending' AND lease_token=?`).bind(terminal ? 'failed' : 'pending', errorMessage, Date.now() + delay, claimed.id, token),
        env.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=?,lease_token=NULL,lease_until=0 WHERE chat_id=? AND lease_token=?').bind(Date.now() + (error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 1000), claimed.chat_id, token),
      ]);
      summary.failed++;
    }
  }
  return summary;
}
