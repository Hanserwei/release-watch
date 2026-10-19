import { z } from 'zod';
import { NEWS_CATEGORIES, type NewsArticle, type NewsCategory, type NewsDashboard, type NewsPhase } from '../shared/news';
import { AppError, type Env } from './env';
import { putSetting, retryDelay, setting } from './db';
import { getDeepSeekApiKey } from './settings';
import { articleSchema, candidateSchema, deduplicateNews, filterNewsBatch } from './news-ai';
import { fetchNewsSource, mergeNewsCandidates, NEWS_SOURCES, type NewsCandidate } from './news-sources';
import { sendTelegramMessage, TelegramError } from './telegram-client';
import { safeTelegramLink, TelegramTextBuilder, type TelegramText } from './telegram-text';

const MAX_ATTEMPTS = 8;
const LEASE_MS = 90_000;
const FILTER_BATCH_SIZE = 12;
interface DigestRow {
  date: string; scheduled_at: number; phase: NewsPhase;
  source_offset: number; source_failures: number; source_successes: number; filter_offset: number;
  candidates_json: string; curated_json: string; articles_json: string; message: string;
  attempts: number; next_attempt_at: number; error: string | null; sent_at: string | null;
}

/** China uses UTC+8 year-round. Each edition spans the preceding 24 hours. */
export function newsSchedule(now: number): { date: string; scheduledAt: number; prepareAt: number } {
  const date = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const scheduledAt = Date.parse(`${date}T08:30:00+08:00`);
  return { date, scheduledAt, prepareAt: scheduledAt - 30 * 60_000 };
}

export function formatNewsDigest(date: string, articles: NewsArticle[]): TelegramText & { articles: NewsArticle[] } {
  const icons: Record<NewsCategory, string> = { tool: '🛠️', model: '🧠', security: '🛡️', insight: '🔎', opensource: '🌐', practice: '💡' };
  const out = new TelegramTextBuilder();
  out.append('🗞️ AI 开发早报', { type: 'bold' }).append(`\n📅 ${date} · 北京时间 08:30\n`)
    .append('⏱️ 截至 08:00 的 24 小时 · 精选速览\n');
  const included: NewsArticle[] = [];
  for (const category of Object.keys(NEWS_CATEGORIES) as NewsCategory[]) {
    let categoryStarted = false;
    for (const article of articles.filter(item => item.category === category)) {
      if (included.length >= 10) break;
      const block = new TelegramTextBuilder();
      if (!categoryStarted) block.append(`\n${icons[category]} ${NEWS_CATEGORIES[category]}\n`, { type: 'bold' });
      const link = safeTelegramLink(article.url);
      block.append(article.importance === 'major' ? '🔥 ' : '▸ ');
      const title = new TelegramTextBuilder().append(article.title, { type: 'bold' }).build();
      block.append(title, link ? { type: 'text_link', url: link } : undefined).append('\n');
      block.append(article.summary).append(`\n🗞️ ${article.source}`, { type: 'italic' });
      if (link) block.append('  ·  ').append('阅读原文 ↗', { type: 'text_link', url: link });
      block.append('\n\n');
      if (out.text.length + block.text.length > 3800) continue;
      out.append(block.build()); categoryStarted = true; included.push(article);
    }
  }
  out.append(`✨ ${included.length} 条精选 · DeepSeek 整理 · 同事件已合并`, { type: 'italic' });
  return { ...out.build(), articles: included };
}

export async function getNewsDashboard(env: Env): Promise<NewsDashboard> {
  const [flag, apiKey, defaultChat, latest] = await Promise.all([
    setting(env, 'news_enabled'), getDeepSeekApiKey(env), setting(env, 'default_chat_id'),
    env.DB.prepare('SELECT * FROM news_digests ORDER BY date DESC LIMIT 1').first<DigestRow>(),
  ]);
  const chatId = defaultChat ?? env.TELEGRAM_CHAT_ID ?? '';
  return {
    enabled: flag !== 'false', deepseekReady: Boolean(apiKey), telegramReady: Boolean(env.TELEGRAM_BOT_TOKEN && /^-?\d+$/.test(chatId)),
    time: '08:30', timezone: 'Asia/Shanghai', sourceCount: NEWS_SOURCES.length,
    latest: latest ? {
      date: latest.date, phase: latest.phase, failed: latest.attempts >= MAX_ATTEMPTS, error: latest.error,
      sourceOffset: latest.source_offset, sourceFailures: latest.source_failures,
      candidateCount: z.array(candidateSchema).parse(JSON.parse(latest.candidates_json)).length,
      filteredCount: z.array(articleSchema).parse(JSON.parse(latest.curated_json)).length,
      scheduledAt: new Date(latest.scheduled_at).toISOString(), sentAt: latest.sent_at,
      articles: z.array(articleSchema).parse(JSON.parse(latest.articles_json)),
    } : null,
  };
}

export async function updateNewsSettings(env: Env, input: Record<string, unknown>): Promise<NewsDashboard> {
  if (typeof input.enabled !== 'boolean' || Object.keys(input).some(key => key !== 'enabled')) throw new AppError('请提供新闻推送开关 enabled（布尔值）');
  await putSetting(env, 'news_enabled', String(input.enabled)).run();
  return getNewsDashboard(env);
}

export async function retryNewsDigest(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare(`UPDATE news_digests SET attempts=0,next_attempt_at=0,error=NULL
    WHERE date=? AND attempts>=? AND phase NOT IN ('sent','empty') AND lease_until<=?`)
    .bind(newsSchedule(now).date, MAX_ATTEMPTS, now).run();
}

/** One bounded step per minute; progress survives deployments, errors and duplicate cron events. */
export async function runNewsTick(env: Env, now = Date.now()): Promise<void> {
  const schedule = newsSchedule(now);
  if (now < schedule.prepareAt || await setting(env, 'news_enabled') === 'false') return;
  const apiKey = await getDeepSeekApiKey(env);
  const chatId = await setting(env, 'default_chat_id') ?? env.TELEGRAM_CHAT_ID ?? '';
  if (!apiKey || !env.TELEGRAM_BOT_TOKEN || !/^-?\d+$/.test(chatId)) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO news_digests(date,scheduled_at,created_at) VALUES(?,?,?)`)
    .bind(schedule.date, schedule.scheduledAt, new Date(now).toISOString()).run();
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(`UPDATE news_digests SET lease_token=?,lease_until=?
    WHERE date=? AND phase NOT IN ('sent','empty') AND attempts<? AND next_attempt_at<=? AND lease_until<=?
    RETURNING *`).bind(token, now + LEASE_MS, schedule.date, MAX_ATTEMPTS, now, now).first<DigestRow>();
  if (!row) return;
  try {
    if (row.phase === 'collecting') {
      const end = Math.min(NEWS_SOURCES.length, row.source_offset + 3);
      const results = await Promise.allSettled(Array.from({ length: end - row.source_offset }, (_, index) =>
        fetchNewsSource(row.source_offset + index, schedule.prepareAt, now)));
      const { results: sent } = await env.DB.prepare(`SELECT json_extract(j.value,'$.url') AS url
        FROM news_digests d,json_each(d.articles_json) j WHERE d.phase='sent' AND d.date>=? AND d.date<?`)
        .bind(new Date(now - 30 * 86_400_000).toISOString().slice(0, 10), schedule.date).all<{ url: string }>();
      let candidates = z.array(candidateSchema).parse(JSON.parse(row.candidates_json));
      let failures = row.source_failures; let successes = row.source_successes;
      for (const result of results) {
        if (result.status === 'rejected') { failures++; continue; }
        successes++;
        candidates = mergeNewsCandidates(candidates, result.value.slice(0, 4), new Set(sent.map(item => item.url)));
      }
      if (end === NEWS_SOURCES.length && !successes) {
        // Retry all sources, rather than publishing an empty edition on a network outage.
        await env.DB.prepare('UPDATE news_digests SET source_offset=0,source_failures=0 WHERE date=? AND lease_token=?').bind(row.date, token).run();
        throw new Error('news_sources_unavailable');
      }
      await env.DB.prepare(`UPDATE news_digests SET source_offset=?,source_failures=?,source_successes=?,candidates_json=?,phase=?,
        attempts=CASE WHEN ?>0 THEN 0 ELSE attempts END,error=CASE WHEN ?>0 THEN NULL ELSE error END,next_attempt_at=0
        WHERE date=? AND lease_token=?`).bind(end, failures, successes, JSON.stringify(candidates), end === NEWS_SOURCES.length ? candidates.length ? 'filtering' : 'empty' : 'collecting', successes, successes, row.date, token).run();
    } else if (row.phase === 'filtering') {
      const candidates = z.array(candidateSchema).parse(JSON.parse(row.candidates_json));
      const batch: NewsCandidate[] = candidates.slice(row.filter_offset, row.filter_offset + FILTER_BATCH_SIZE);
      const filtered = await filterNewsBatch(batch, apiKey);
      const curated = [...z.array(articleSchema).parse(JSON.parse(row.curated_json)), ...filtered];
      const offset = row.filter_offset + batch.length;
      await env.DB.prepare(`UPDATE news_digests SET filter_offset=?,curated_json=?,phase=?,attempts=0,error=NULL,next_attempt_at=0
        WHERE date=? AND lease_token=?`).bind(offset, JSON.stringify(curated), offset >= candidates.length ? curated.length ? 'deduplicating' : 'empty' : 'filtering', row.date, token).run();
    } else if (row.phase === 'deduplicating') {
      const curated = z.array(articleSchema).parse(JSON.parse(row.curated_json))
        .sort((a, b) => Number(b.importance === 'major') - Number(a.importance === 'major') || b.publishedAt.localeCompare(a.publishedAt)).slice(0, 60);
      const unique = await deduplicateNews(curated, apiKey);
      const formatted = formatNewsDigest(row.date, unique);
      await env.DB.prepare(`UPDATE news_digests SET articles_json=?,message=?,phase=?,attempts=0,error=NULL,next_attempt_at=0
        WHERE date=? AND lease_token=?`).bind(JSON.stringify(formatted.articles), formatted.text, formatted.articles.length ? 'ready' : 'empty', row.date, token).run();
    } else if (row.phase === 'ready' && now >= row.scheduled_at) {
      // Recheck switches and the target after preparation, just before sending.
      if (await setting(env, 'news_enabled') === 'false' || !await getDeepSeekApiKey(env)) return;
      const target = await setting(env, 'default_chat_id') ?? env.TELEGRAM_CHAT_ID ?? '';
      if (target !== chatId) return;
      const lock = await env.DB.prepare(`INSERT INTO chat_delivery_locks(chat_id,next_send_at,lease_token,lease_until) VALUES(?,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET next_send_at=excluded.next_send_at,lease_token=excluded.lease_token,lease_until=excluded.lease_until
        WHERE chat_delivery_locks.next_send_at<=? AND chat_delivery_locks.lease_until<=? RETURNING chat_id`)
        .bind(chatId, now + 1000, token, now + LEASE_MS, now, now).first();
      if (!lock) return;
      let sendDelay = 1000;
      try {
        const articles = z.array(articleSchema).parse(JSON.parse(row.articles_json));
        const message = formatNewsDigest(row.date, articles);
        const messageId = await sendTelegramMessage(env, chatId, message);
        await env.DB.batch([
          env.DB.prepare(`UPDATE news_digests SET phase='sent',sent_at=?,telegram_message_id=?,attempts=0,error=NULL WHERE date=? AND lease_token=?`)
            .bind(new Date(now).toISOString(), messageId, row.date, token),
          putSetting(env, 'last_news_delivery_at', new Date(now).toISOString()),
        ]);
      } catch (error) {
        if (error instanceof TelegramError) sendDelay = Math.max(1000, (error.retryAfter ?? 60) * 1000);
        throw error;
      } finally {
        await env.DB.prepare(`UPDATE chat_delivery_locks SET lease_token=NULL,lease_until=0,next_send_at=? WHERE chat_id=? AND lease_token=?`)
          .bind(now + sendDelay, chatId, token).run();
      }
    }
  } catch (error) {
    const attempts = row.attempts + 1;
    const permanent = error instanceof TelegramError && error.permanent;
    const delay = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : retryDelay(attempts);
    const message = row.phase === 'collecting' ? '新闻源暂时无法访问，稍后重试'
      : row.phase === 'ready' ? 'Telegram 推送失败，请检查机器人与绑定状态' : 'DeepSeek 整理失败或返回内容不完整，稍后重试';
    await env.DB.prepare('UPDATE news_digests SET attempts=?,next_attempt_at=?,error=? WHERE date=? AND lease_token=?')
      .bind(permanent ? MAX_ATTEMPTS : attempts, now + delay, message, row.date, token).run();
    console.error(JSON.stringify({ event: 'news_step_failed', phase: row.phase }));
  } finally {
    await env.DB.prepare('UPDATE news_digests SET lease_token=NULL,lease_until=0 WHERE date=? AND lease_token=?').bind(row.date, token).run();
  }
}
