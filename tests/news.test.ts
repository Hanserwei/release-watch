import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import worker from '../src/server';
import type { Env } from '../src/server/env';
import type { NewsArticle, NewsPhase } from '../src/shared/news';
import { getNewsDashboard, newsSchedule, formatNewsDigest, retryNewsDigest, runNewsTick } from '../src/server/news';
import { filterNewsBatch, deduplicateNews } from '../src/server/news-ai';
import { canonicalNewsUrl, fetchNewsSource, mergeNewsCandidates, NEWS_SOURCES, parseNewsFeed, type NewsCandidate } from '../src/server/news-sources';
import { initializeTestSchema } from './schema';

const bindings = env as unknown as Env;
const runtime: Env = { ...bindings, DEEPSEEK_API_KEY: 'sk-news-test-key-0123456789abcdef' };
const prepareAt = Date.parse('2026-10-19T08:00:00+08:00');
const sendAt = Date.parse('2026-10-19T08:30:00+08:00');
const candidate: NewsCandidate = { title: 'AI 编程工具发布', url: 'https://news.example/ai', summary: '工具新增 Agent 工作流', source: '测试来源', publishedAt: '2026-10-18T20:00:00.000Z' };
const article: NewsArticle = { ...candidate, summary: '编程工具新增 Agent 工作流，可协助完成代码审查与测试。', category: 'tool', importance: 'major' };

function completion(content: unknown): Response {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
}
async function seedDigest(phase: NewsPhase, now = sendAt): Promise<void> {
  const schedule = newsSchedule(now);
  await bindings.DB.prepare(`INSERT INTO news_digests(date,scheduled_at,phase,candidates_json,curated_json,articles_json,message,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(schedule.date, schedule.scheduledAt, phase, JSON.stringify([candidate]), JSON.stringify([article]), JSON.stringify([article]), formatNewsDigest(schedule.date, [article]).text, new Date(now).toISOString()).run();
}

beforeAll(async () => { await initializeTestSchema(bindings.DB); });
beforeEach(async () => {
  await bindings.DB.batch(['news_digests', 'settings', 'chat_delivery_locks'].map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
  // Every network call is mocked, including failure paths. No real model or Telegram requests.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('news source normalization', () => {
  it('reads RSS CDATA, cleans tracking URLs and enforces a dated 24-hour window', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[AI &amp; Code]]></title><link>https://news.example/a?utm_source=rss&amp;id=1#top</link><description><![CDATA[<p>新工具</p><script>ignore()</script>]]></description><pubDate>Mon, 19 Oct 2026 00:00:00 GMT</pubDate></item>
      <item><title>过期</title><link>https://news.example/old</link><pubDate>Sat, 17 Oct 2026 00:00:00 GMT</pubDate></item>
      <item><title>无日期</title><link>https://news.example/undated</link></item>
      <item><title>未来</title><link>https://news.example/future</link><pubDate>Tue, 20 Oct 2026 00:00:00 GMT</pubDate></item>
      </channel></rss>`;
    const result = parseNewsFeed(xml, 'RSS', 'https://news.example/feed', sendAt);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'AI & Code', url: 'https://news.example/a?id=1', summary: '新工具', publishedAt: '2026-10-19T00:00:00.000Z' });
  });
  it('reads Atom alternate links and namespaced RSS dates', () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>模型发布</title><link rel="self" href="/api/1"/><link rel="alternate" href="/news/1"/><updated>2026-10-19T07:00:00+08:00</updated><summary>模型新闻</summary></entry></feed>`;
    expect(parseNewsFeed(atom, 'Atom', 'https://news.example/feed', sendAt)[0].url).toBe('https://news.example/news/1');
    const rss = `<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>AI</title><link>https://news.example/1</link><dc:date>2026-10-19T07:00:00+08:00</dc:date></item></channel></rss>`;
    expect(parseNewsFeed(rss, 'RSS', 'https://news.example/feed', sendAt)).toHaveLength(1);
  });
  it('rejects entity declarations, malformed XML, unsafe links and future data', () => {
    expect(() => parseNewsFeed('<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>', 'RSS', 'https://news.example', sendAt)).toThrow();
    expect(() => parseNewsFeed('<rss><channel>', 'RSS', 'https://news.example', sendAt)).toThrow();
    expect(canonicalNewsUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalNewsUrl('https://user:password@news.example')).toBeNull();
    const xml = `<rss><channel><item><title>AI</title><link>https://news.example/future</link><pubDate>2026-10-19T08:15:00+08:00</pubDate></item></channel></rss>`;
    expect(parseNewsFeed(xml, 'RSS', 'https://news.example/feed', sendAt, prepareAt)).toEqual([]);
  });
  it('deduplicates URL/title and excludes previously delivered links', () => {
    expect(mergeNewsCandidates([candidate], [{ ...candidate, url: 'https://other.example/a' }, { ...candidate, title: 'other' }], new Set())).toEqual([candidate]);
    expect(mergeNewsCandidates([], [candidate], new Set([candidate.url]))).toEqual([]);
  });
  it('extracts Trending with an explicit discovery-date caveat', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<article class="Box-row"><h2><a href="/example/ai-tool">Example</a></h2><p>AI agent coding</p></article>'));
    const result = await fetchNewsSource(NEWS_SOURCES.length - 1, sendAt, prepareAt);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'example/ai-tool', url: 'https://github.com/example/ai-tool', publishedAt: new Date(prepareAt).toISOString() });
    expect(result[0].summary).toContain('非项目发布日期');
  });
});

describe('DeepSeek structured news processing', () => {
  it('retains only relevant articles with original source links', async () => {
    vi.mocked(fetch).mockResolvedValue(completion({ articles: [
      { index: 0, relevant: true, category: 'tool', importance: 'major', summary: article.summary, url: 'https://invented.example' },
      { index: 1, relevant: false },
    ] }));
    expect(await filterNewsBatch([candidate, { ...candidate, title: '广告' }], 'fake-key')).toEqual([article]);
    const request = vi.mocked(fetch).mock.calls[0];
    expect(request[0]).toBe('https://api.deepseek.com/chat/completions');
    expect(String(request[1]?.body)).toContain('json_object');
  });
  it.each([
    { articles: [] },
    { articles: [{ index: 0, relevant: 'false' }] },
    { articles: [{ index: 2, relevant: false }] },
    { articles: [{ index: 0, relevant: true, category: 'unknown', importance: 'major', summary: 'text' }] },
  ])('rejects incomplete or invalid classification: %j', async content => {
    vi.mocked(fetch).mockResolvedValue(completion(content));
    await expect(filterNewsBatch([candidate], 'fake-key')).rejects.toThrow();
  });
  it('rejects repeated indices instead of silently losing an input', async () => {
    vi.mocked(fetch).mockResolvedValue(completion({ articles: [{ index: 0, relevant: false }, { index: 0, relevant: false }] }));
    await expect(filterNewsBatch([candidate, candidate], 'fake-key')).rejects.toThrow();
  });
  it('rejects truncated completion and deduplicates across sources by selected index', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
    await expect(filterNewsBatch([candidate], 'fake-key')).rejects.toThrow();
    const other = { ...article, url: 'https://other.example/report' };
    vi.mocked(fetch).mockResolvedValueOnce(completion({ keep: [1] }));
    expect(await deduplicateNews([article, other], 'fake-key')).toEqual([other]);
    vi.mocked(fetch).mockResolvedValueOnce(completion({ keep: [0, 0] }));
    await expect(deduplicateNews([article, other], 'fake-key')).rejects.toThrow();
  });
});

describe('Beijing daily schedule and durable delivery', () => {
  it('computes UTC+8 date boundaries and does no work before 08:00', async () => {
    expect(newsSchedule(Date.parse('2026-12-31T16:30:00Z'))).toEqual({ date: '2027-01-01', prepareAt: Date.parse('2027-01-01T00:00:00Z'), scheduledAt: Date.parse('2027-01-01T00:30:00Z') });
    await runNewsTick(runtime, prepareAt - 1);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getNewsDashboard(runtime)).latest).toBeNull();
  });
  it('does not send before 08:30 and sends once despite concurrent/repeated ticks', async () => {
    await seedDigest('ready');
    vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true, result: { message_id: 42 } }));
    await runNewsTick(runtime, sendAt - 1);
    expect(fetch).not.toHaveBeenCalled();
    await Promise.all([runNewsTick(runtime, sendAt), runNewsTick(runtime, sendAt)]);
    await runNewsTick(runtime, sendAt + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getNewsDashboard(runtime)).latest).toMatchObject({ phase: 'sent', sentAt: new Date(sendAt).toISOString() });
  });
  it('blocks processing and sending when either switch, key, or Telegram target is unavailable', async () => {
    await seedDigest('ready');
    await runNewsTick({ ...runtime, DEEPSEEK_API_KEY: undefined }, sendAt);
    await runNewsTick({ ...runtime, TELEGRAM_BOT_TOKEN: undefined }, sendAt);
    await runNewsTick({ ...runtime, TELEGRAM_CHAT_ID: undefined }, sendAt);
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_enabled','false')").run();
    await runNewsTick(runtime, sendAt);
    await bindings.DB.prepare('DELETE FROM settings').run();
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('news_enabled','false')").run();
    await runNewsTick(runtime, sendAt);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves progress on model failure and resumes instead of publishing raw articles', async () => {
    await seedDigest('filtering');
    await bindings.DB.prepare("UPDATE news_digests SET curated_json='[]'").run();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('secret error text', { status: 503 }));
    await runNewsTick(runtime, prepareAt);
    expect(await bindings.DB.prepare('SELECT phase,filter_offset,attempts,next_attempt_at FROM news_digests').first()).toMatchObject({ phase: 'filtering', filter_offset: 0, attempts: 1, next_attempt_at: prepareAt + 60_000 });
    expect(JSON.stringify(await getNewsDashboard(runtime))).not.toContain('secret error text');
    await runNewsTick(runtime, prepareAt + 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(completion({ articles: [{ index: 0, relevant: true, category: 'tool', importance: 'major', summary: article.summary }] }));
    await runNewsTick(runtime, prepareAt + 60_000);
    expect((await getNewsDashboard(runtime)).latest).toMatchObject({ phase: 'deduplicating', failed: false, filteredCount: 1, error: null });
  });
  it('respects Telegram retry_after and shares the chat delivery lock', async () => {
    await seedDigest('ready');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, parameters: { retry_after: 120 } }, { status: 429 }));
    await runNewsTick(runtime, sendAt);
    expect((await getNewsDashboard(runtime)).latest?.phase).toBe('ready');
    await runNewsTick(runtime, sendAt + 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await bindings.DB.prepare('SELECT next_send_at,lease_until FROM chat_delivery_locks').first()).toEqual({ next_send_at: sendAt + 120_000, lease_until: 0 });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 43 } }));
    await runNewsTick(runtime, sendAt + 120_000);
    expect((await getNewsDashboard(runtime)).latest?.phase).toBe('sent');
  });
  it('does not send while a release holds the chat lock', async () => {
    await seedDigest('ready');
    await bindings.DB.prepare('INSERT INTO chat_delivery_locks(chat_id,next_send_at,lease_token,lease_until) VALUES(?,?,?,?)').bind(runtime.TELEGRAM_CHAT_ID!, 0, 'release-token', sendAt + 60_000).run();
    await runNewsTick(runtime, sendAt);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows retrying a failed current edition without reopening sent or old editions', async () => {
    await seedDigest('ready');
    await bindings.DB.prepare('UPDATE news_digests SET attempts=8').run();
    await runNewsTick(runtime, sendAt);
    expect(fetch).not.toHaveBeenCalled();
    await retryNewsDigest(runtime, sendAt);
    expect((await getNewsDashboard(runtime)).latest?.failed).toBe(false);
    await bindings.DB.prepare("UPDATE news_digests SET phase='sent',attempts=8").run();
    await retryNewsDigest(runtime, sendAt);
    expect(await bindings.DB.prepare('SELECT phase,attempts FROM news_digests').first()).toEqual({ phase: 'sent', attempts: 8 });
  });
  it('runs the full multi-source pipeline, topic dedup and scheduled send with mocked network', async () => {
    const sentRequests: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api.telegram.org/')) {
        sentRequests.push(String(init?.body));
        return Response.json({ ok: true, result: { message_id: 99 } });
      }
      if (url === 'https://api.deepseek.com/chat/completions') {
        const body = z.object({ messages: z.array(z.object({ content: z.string() })) }).parse(JSON.parse(String(init?.body)));
        const data = z.array(z.object({ index: z.number() })).parse(JSON.parse(body.messages[1].content));
        return body.messages[0].content.startsWith('合并') ? completion({ keep: [0, 1, 2] }) : completion({ articles: data.map(item => ({ index: item.index, relevant: true, category: 'tool', importance: 'normal', summary: 'AI 编程工具的新功能让开发者更方便地完成代码审查与自动化测试。' })) });
      }
      const index = NEWS_SOURCES.findIndex(source => source.url === url);
      if (index < 0) throw new Error('unexpected request');
      if (index === NEWS_SOURCES.length - 1) return new Response('<article class="Box-row"><h2><a href="/example/agent">agent</a></h2><p>AI agent</p></article>');
      return new Response(`<rss><channel><item><title>AI 工具 ${index}</title><link>https://news.example/item/${index}</link><pubDate>2026-10-19T07:00:00+08:00</pubDate><description>AI 编程工作流</description></item></channel></rss>`);
    });
    for (let minute = 0; minute < 20; minute++) await runNewsTick(runtime, prepareAt + minute * 60_000);
    expect((await getNewsDashboard(runtime)).latest).toMatchObject({ phase: 'ready', sourceOffset: NEWS_SOURCES.length, sourceFailures: 0, candidateCount: NEWS_SOURCES.length });
    expect(sentRequests).toHaveLength(0);
    await runNewsTick(runtime, sendAt);
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toContain('AI 开发早报');
    expect((await getNewsDashboard(runtime)).latest?.articles).toHaveLength(3);
  });
  it('keeps complete article links within Telegram message limits', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ ...article, title: '长标题'.repeat(70), summary: '长摘要'.repeat(50), url: 'https://news.example/' + String(index).repeat(1000) }));
    const digest = formatNewsDigest('2026-10-19', items);
    expect(digest.text.length).toBeLessThanOrEqual(3900);
    expect(digest.articles.length).toBeGreaterThan(0);
    expect(digest.articles.length).toBeLessThan(items.length);
    for (const item of digest.articles) expect(digest.text).toContain(item.url + (digest.text.endsWith(item.url) ? '' : '\n'));
  });
});

describe('news admin endpoints', () => {
  it('requires authentication and validates the independent news switch', async () => {
    const request = (path: string, init?: RequestInit) => worker.fetch!(new Request('https://release-watch.example' + path, init), runtime, {} as ExecutionContext);
    expect((await request('/api/news')).status).toBe(401);
    expect((await request('/api/settings/news', { method: 'PATCH', body: '{"enabled":false}' })).status).toBe(401);
    expect((await request('/api/news/retry', { method: 'POST' })).status).toBe(401);
    const headers = { Authorization: 'Bearer ' + runtime.ADMIN_TOKEN, 'Content-Type': 'application/json' };
    expect((await request('/api/settings/news', { method: 'PATCH', headers, body: '{"enabled":"false"}' })).status).toBe(400);
    const response = await request('/api/settings/news', { method: 'PATCH', headers, body: '{"enabled":false}' });
    expect(await response.json()).toMatchObject({ enabled: false, timezone: 'Asia/Shanghai', time: '08:30' });
    const status = await request('/api/news', { headers });
    const text = await status.text();
    expect(text).not.toContain(runtime.DEEPSEEK_API_KEY);
    expect(text).not.toContain(runtime.TELEGRAM_BOT_TOKEN);
  });
});

describe('news source recovery and empty editions', () => {
  it('stops after eight complete source outages rather than resetting the failure count between batches', async () => {
    let now = prepareAt;
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (let batch = 0; batch < Math.ceil(NEWS_SOURCES.length / 3); batch++) {
        await runNewsTick(runtime, now);
        now += 60_000;
      }
      const row = await bindings.DB.prepare('SELECT attempts,next_attempt_at,phase FROM news_digests').first<{ attempts: number; next_attempt_at: number; phase: string }>();
      expect(row).toMatchObject({ attempts: attempt, phase: 'collecting' });
      now = Math.max(now, row!.next_attempt_at);
    }
    expect((await getNewsDashboard(runtime)).latest?.failed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(NEWS_SOURCES.length * 8);
    await runNewsTick(runtime, now);
    expect(fetch).toHaveBeenCalledTimes(NEWS_SOURCES.length * 8);
  });
  it('excludes URLs sent by previous editions before spending model tokens', async () => {
    await seedDigest('sent', prepareAt - 86_400_000);
    vi.mocked(fetch).mockResolvedValue(new Response(`<rss><channel><item><title>${candidate.title}</title><link>${candidate.url}</link><pubDate>${candidate.publishedAt}</pubDate></item></channel></rss>`));
    for (let minute = 0; minute < 9; minute++) await runNewsTick(runtime, prepareAt + minute * 60_000);
    expect((await getNewsDashboard(runtime)).latest).toMatchObject({ phase: 'empty', candidateCount: 0 });
    expect(vi.mocked(fetch).mock.calls.every(call => call[0] !== 'https://api.deepseek.com/chat/completions')).toBe(true);
  });
  it('does not send anything when all candidates are irrelevant', async () => {
    await seedDigest('filtering');
    await bindings.DB.prepare("UPDATE news_digests SET curated_json='[]'").run();
    vi.mocked(fetch).mockResolvedValueOnce(completion({ articles: [{ index: 0, relevant: false }] }));
    await runNewsTick(runtime, sendAt);
    await runNewsTick(runtime, sendAt + 60_000);
    expect((await getNewsDashboard(runtime)).latest?.phase).toBe('empty');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('uses consecutive 08:00 windows so news between 08:00 and 08:30 is retained for the next day', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(`<rss><channel>
    <item><title>前一期准备期间发布</title><link>https://news.example/between</link><pubDate>2026-10-18T08:15:00+08:00</pubDate></item>
    <item><title>下一期内容</title><link>https://news.example/tomorrow</link><pubDate>2026-10-19T08:15:00+08:00</pubDate></item>
    </channel></rss>`));
  for (let minute = 0; minute < 9; minute++) await runNewsTick(runtime, prepareAt + minute * 60_000);
  expect((await getNewsDashboard(runtime)).latest).toMatchObject({ phase: 'filtering', candidateCount: 1 });
  const stored = await bindings.DB.prepare('SELECT candidates_json FROM news_digests').first<{ candidates_json: string }>();
  expect(stored?.candidates_json).toContain('https://news.example/between');
  expect(stored?.candidates_json).not.toContain('https://news.example/tomorrow');
});
