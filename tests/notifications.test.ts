import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../src/server/env';
import { initializeTestSchema } from './schema';
import { notificationChangelog } from '../src/server/changelog';
import { deliverPending } from '../src/server/deliveries';
import { updateSubscription } from '../src/server/subscriptions';
import { fetchReleasePage } from '../src/server/github';
import { runChecks } from '../src/server/poller';

const bindings = env as unknown as Env;
let fetchMock: Mock<typeof fetch>;
const original = '## Features\n- Add search\n## Fixes\n- Correct timezone conversion';

beforeAll(async () => { await initializeTestSchema(bindings.DB); });
beforeEach(async () => {
  await bindings.DB.exec('DELETE FROM deliveries; DELETE FROM subscriptions; DELETE FROM releases; DELETE FROM projects; DELETE FROM settings; DELETE FROM chat_delivery_locks;');
  const now = new Date().toISOString();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO projects(id,repo,created_at,next_check_at,is_public) VALUES(1,'owner/repo',?,?,1)").bind(now, now),
    bindings.DB.prepare("INSERT INTO subscriptions(id,project_id,chat_id,created_at,notify_after) VALUES(1,1,'12345',?,'2000-01-01T00:00:00.000Z')").bind(now),
    bindings.DB.prepare("INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token) VALUES(1,1,'v1','Release 1','https://github.com/owner/repo/releases/tag/v1',?,0,?,?,?,'fixture')").bind(original, now, now, now),
    bindings.DB.prepare("INSERT INTO deliveries(id,release_id,chat_id,created_at) VALUES(1,1,'12345',?)").bind(now),
  ]);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function sourceRelease() {
  return (await bindings.DB.prepare('SELECT id,tag,body,changelog_zh FROM releases WHERE id=1').first<{ id: number; tag: string; body: string; changelog_zh: string | null }>())!;
}
async function readyNextPart() {
  await bindings.DB.batch([
    bindings.DB.prepare('UPDATE deliveries SET next_attempt_at=0'),
    bindings.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=0'),
  ]);
}

describe('optional Chinese changelog summaries', () => {
  it('retains GitHub release notes beyond the old preview length', async () => {
    const body = 'A release note.\n'.repeat(1000) + 'Breaking change at the end.';
    fetchMock.mockResolvedValue(Response.json([{ id: 1, tag_name: 'v1', name: 'Release 1', body,
      prerelease: false, published_at: new Date().toISOString() }]));
    expect((await fetchReleasePage(bindings, 'owner/repo', 1)).releases[0].body).toBe(body);
  });
  it('includes upgrade warnings at the end of a long changelog in the model input', async () => {
    const body = 'A release note.\n'.repeat(2000) + 'BREAKING: migrate configuration before upgrading.';
    await bindings.DB.prepare('UPDATE releases SET body=? WHERE id=1').bind(body).run();
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: '升级前需要迁移配置。' }, finish_reason: 'stop' }] }));
    await notificationChangelog({ ...bindings, DEEPSEEK_API_KEY: 'sk-env-test-placeholder-only' }, { ...await sourceRelease(), repo: 'owner/repo' });
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(JSON.parse(request.messages[1].content).changelog).toBe(body);
  });
  it('uses DeepSeek once, caches the Chinese summary, and leaves the source body intact', async () => {
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_api_key','sk-secret-test-placeholder-only')").run();
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: '新增搜索功能；修复时区转换。' }, finish_reason: 'stop' }] }));
    const source = { ...await sourceRelease(), repo: 'owner/repo' };
    const result = await notificationChangelog(bindings, source);
    expect(result).toBe('中文更新摘要（DeepSeek）\n新增搜索功能；修复时区转换。');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer sk-secret-test-placeholder-only' });
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'deepseek-chat' });
    const stored = await sourceRelease();
    expect(stored.body).toBe(original);
    expect(stored.changelog_zh).toBe(result);
    expect(await notificationChangelog(bindings, { ...stored, repo: 'owner/repo' })).toBe(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['body', 'tag', 'unchanged'] as const)('refreshes the summary cache when GitHub updates %s', async change => {
    await bindings.DB.prepare("UPDATE releases SET changelog_zh='cached Chinese summary' WHERE id=1").run();
    fetchMock.mockImplementation(async url => String(url).includes('/releases?')
      ? Response.json([{ id: 1, tag_name: change === 'tag' ? 'v1.1' : 'v1', name: 'Release 1',
        body: change === 'body' ? 'New release details' : original, prerelease: false, published_at: new Date().toISOString() }])
      : Response.json({ private: false }));
    expect((await runChecks(bindings, { projectId: 1, force: true })).errors).toBe(0);
    expect((await sourceRelease()).changelog_zh).toBe(change === 'unchanged' ? 'cached Chinese summary' : null);
  });
  it.each(['http', 'timeout', 'json', 'empty', 'truncated'] as const)('falls back to the exact original on %s failure', async failure => {
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_api_key','sk-secret-test-placeholder-only')").run();
    if (failure === 'http') fetchMock.mockResolvedValue(new Response('private error', { status: 503 }));
    if (failure === 'timeout') fetchMock.mockRejectedValue(new DOMException('private error', 'TimeoutError'));
    if (failure === 'json') fetchMock.mockResolvedValue(new Response('not JSON'));
    if (failure === 'empty') fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: ' ' } }] }));
    if (failure === 'truncated') fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }));
    expect(await notificationChangelog(bindings, { ...await sourceRelease(), repo: 'owner/repo' })).toBe(original);
    expect((await sourceRelease()).changelog_zh).toBeNull();
  });
  it('skips the model without credentials or when disabled, even with a cached summary', async () => {
    const source = { ...await sourceRelease(), repo: 'owner/repo', changelog_zh: 'old summary' };
    expect(await notificationChangelog(bindings, source)).toBe(original);
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_enabled','false')").run();
    expect(await notificationChangelog({ ...bindings, DEEPSEEK_API_KEY: 'sk-env-test-placeholder-only' }, source)).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('cover notifications and complete original fallback', () => {
  it('uploads bundled PNG bytes as a photo with the summary in its caption', async () => {
    await bindings.DB.prepare("UPDATE projects SET cover_url='/covers/halo.png' WHERE id=1").run();
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_api_key','sk-secret-test-placeholder-only')").run();
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '新增搜索，修复时区。' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 42 } }));
    const assetFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([137,80,78,71]), { headers: { 'Content-Type': 'image/png' } }));
    const result = await deliverPending({ ...bindings, ASSETS: { fetch: assetFetch } as unknown as Fetcher });
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(assetFetch).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('/sendPhoto');
    const body = init?.body as FormData;
    expect(body.get('chat_id')).toBe('12345');
    expect(body.get('caption')).toContain('中文更新摘要（DeepSeek）\n新增搜索，修复时区。');
    expect(body.get('photo')).toBeInstanceOf(Blob);
    expect(await bindings.DB.prepare('SELECT status,photo_message_id FROM deliveries').first()).toEqual({ status: 'sent', photo_message_id: 42 });
  });
  it('falls back to text on an invalid photo without marking delivery as failed', async () => {
    await bindings.DB.prepare("UPDATE projects SET cover_url='https://images.example.com/broken.png' WHERE id=1").run();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, description: 'bad photo' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 7 } }));
    expect(await deliverPending(bindings)).toEqual({ sent: 1, failed: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sendPhoto');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/sendMessage');
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string).text).toContain(original);
  });
  it('resumes a long original after rate limiting without duplicating the cover or earlier text', async () => {
    const longBody = 'Original changelog line.\n'.repeat(500) + '最后一项修复。';
    await bindings.DB.prepare("UPDATE projects SET cover_url='https://images.example.com/cover.png' WHERE id=1").run();
    await bindings.DB.prepare('UPDATE releases SET body=? WHERE id=1').bind(longBody).run();
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_api_key','sk-secret-test-placeholder-only')").run();
    fetchMock.mockImplementation(async (url) => String(url).includes('deepseek.com')
      ? new Response(null, { status: 503 }) : Response.json({ ok: true, result: { message_id: 90 } }));
    expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 0 });
    const caption = JSON.parse(fetchMock.mock.calls[1][1]?.body as string).caption as string;
    await readyNextPart();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, parameters: { retry_after: 10 } }, { status: 429 }));
    expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 1 });
    const parts: string[] = [caption];
    fetchMock.mockImplementation(async (_url, init) => {
      parts.push(JSON.parse(init?.body as string).text);
      return Response.json({ ok: true, result: { message_id: 91 } });
    });
    for (let n = 0; n < 5; n++) {
      await readyNextPart();
      await deliverPending(bindings);
    }
    const row = await bindings.DB.prepare('SELECT status,notification_text,text_offset,photo_message_id FROM deliveries').first<{ status: string; notification_text: string; text_offset: number; photo_message_id: number }>();
    expect(row!.status).toBe('sent');
    expect(parts.join('')).toBe(row!.notification_text);
    expect(parts.join('')).toContain(longBody);
    expect(row!.text_offset).toBe(row!.notification_text.length);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/sendPhoto'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('deepseek.com'))).toHaveLength(1);
  });
  it('does not notify if the subscription is paused during the model request', async () => {
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_api_key','sk-secret-test-placeholder-only')").run();
    fetchMock.mockImplementation(async () => {
      await updateSubscription(bindings, 1, { paused: true });
      return Response.json({ choices: [{ message: { content: '中文摘要' }, finish_reason: 'stop' }] });
    });
    expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM deliveries').first()).toEqual({ n: 0 });
  });
});
