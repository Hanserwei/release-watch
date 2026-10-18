import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../src/server/env';
import { getPublicDashboard } from '../src/server/public';
import { addSubscription, removeSubscription } from '../src/server/subscriptions';
import { runChecks } from '../src/server/poller';
import { initializeTestSchema } from './schema';

const bindings = env as unknown as Env;
const now = Date.parse('2026-10-17T12:00:00.000Z');
const timestamp = new Date(now).toISOString();
const old = '2020-01-01T00:00:00.000Z';
let upstream: Mock<typeof fetch>;

async function seedProject(repo: string, isPublic = 1, checkedAt: string | null = timestamp) {
  const project = await bindings.DB.prepare('INSERT INTO projects(repo,created_at,next_check_at) VALUES(?,?,?) RETURNING id')
    .bind(repo, old, timestamp).first<{ id: number }>();
  await bindings.DB.prepare('UPDATE projects SET is_public=?,visibility_checked_at=? WHERE id=?').bind(isPublic, checkedAt, project!.id).run();
  const subscription = await bindings.DB.prepare('INSERT INTO subscriptions(project_id,chat_id,created_at,notify_after) VALUES(?,?,?,?) RETURNING id')
    .bind(project!.id, '12345', old, timestamp).first<{ id: number }>();
  return { projectId: project!.id, subscriptionId: subscription!.id };
}
async function seedRelease(projectId: number, id: number, prerelease = false, publishedAt = old) {
  await bindings.DB.prepare(`INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token)
    VALUES(?,?,?,?,'https://untrusted.example/legacy','Release notes',?,?,?,?, 'fixture')`)
    .bind(id, projectId, `v${id}`, `Release ${id}`, Number(prerelease), publishedAt, timestamp, publishedAt).run();
}

beforeAll(async () => { await initializeTestSchema(bindings.DB); });
beforeEach(async () => {
  await bindings.DB.batch(['subscription_release_skips', 'deliveries', 'releases', 'subscriptions', 'projects', 'settings', 'chat_delivery_locks', 'telegram_updates']
    .map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  upstream = vi.fn<typeof fetch>(async input => new URL(String(input)).pathname.endsWith('/releases')
    ? Response.json([]) : Response.json({ private: false }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('public dashboard visibility and disclosure', () => {
  it('returns a read-only empty dashboard with only public status fields', async () => {
    expect(await getPublicDashboard(bindings)).toEqual({ subscriptions: [], releases: [], status: {
      lastCronAt: null, projectCount: 0, activeSubscriptions: 0, errorProjects: 0, intervalMinutes: 15,
    } });
    expect(upstream).not.toHaveBeenCalled();
  });
  it('hides old rows by default and excludes private, unknown, stale, future, and unsubscribed sources', async () => {
    const visible = await seedProject('owner/public');
    const privateProject = await seedProject('owner/private', 0);
    const unknown = await seedProject('owner/unknown', 1, null);
    const stale = await seedProject('owner/stale', 1, new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString());
    const future = await seedProject('owner/future', 1, new Date(now + 1).toISOString());
    const cancelled = await seedProject('owner/cancelled');
    const legacy = await bindings.DB.prepare('INSERT INTO projects(repo,created_at,next_check_at) VALUES(?,?,?) RETURNING id,is_public,visibility_checked_at')
      .bind('owner/legacy', old, timestamp).first<{ id: number; is_public: number; visibility_checked_at: string | null }>();
    expect(legacy).toMatchObject({ is_public: 0, visibility_checked_at: null });
    await bindings.DB.prepare('INSERT INTO subscriptions(project_id,created_at,notify_after) VALUES(?,?,?)').bind(legacy!.id, old, timestamp).run();
    const projects = [visible, privateProject, unknown, stale, future, cancelled, { projectId: legacy!.id }];
    for (let i = 0; i < projects.length; i++) await seedRelease(projects[i].projectId, i + 1);
    await removeSubscription(bindings, cancelled.subscriptionId);
    const result = await getPublicDashboard(bindings);
    expect(result.subscriptions.map(row => row.repo)).toEqual(['owner/public']);
    expect(result.releases.map(row => row.id)).toEqual([1]);
    expect(result.status).toMatchObject({ projectCount: 1, activeSubscriptions: 1, errorProjects: 0 });
    expect(JSON.stringify(result)).not.toMatch(/owner\/(private|unknown|stale|future|cancelled|legacy)/);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('accepts a verification exactly 24 hours old and hides it as soon as it expires', async () => {
    await seedProject('owner/boundary', 1, new Date(now - 24 * 60 * 60 * 1000).toISOString());
    expect((await getPublicDashboard(bindings)).subscriptions).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(now + 1);
    expect((await getPublicDashboard(bindings)).subscriptions).toHaveLength(0);
  });
  it('deduplicates shared projects, aggregates options, and scopes counters to visible projects', async () => {
    const shared = await seedProject('owner/shared');
    await bindings.DB.prepare('UPDATE subscriptions SET paused=1,interval_minutes=60 WHERE id=?').bind(shared.subscriptionId).run();
    await bindings.DB.prepare(`INSERT INTO subscriptions(project_id,chat_id,include_prerelease,interval_minutes,created_at,notify_after)
      VALUES(?,'67890',1,30,?,?)`).bind(shared.projectId, old, timestamp).run();
    const paused = await seedProject('owner/paused');
    await bindings.DB.prepare('UPDATE subscriptions SET paused=1,interval_minutes=360 WHERE id=?').bind(paused.subscriptionId).run();
    const hidden = await seedProject('owner/private', 0);
    await bindings.DB.prepare('UPDATE projects SET error=? WHERE id IN (?,?)')
      .bind('credential secret and private upstream body', shared.projectId, hidden.projectId).run();
    await seedRelease(shared.projectId, 1);
    await seedRelease(shared.projectId, 2, true, timestamp);
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('last_cron_at',?)").bind(timestamp).run();
    const result = await getPublicDashboard(bindings);
    expect(result.subscriptions).toHaveLength(2);
    expect(result.subscriptions.find(row => row.projectId === shared.projectId)).toMatchObject({
      id: shared.subscriptionId, paused: false, includePrerelease: true, intervalMinutes: 30,
      latestTag: 'v2', latestUrl: 'https://github.com/owner/shared/releases/tag/v2', error: '检查暂时异常，请稍后查看',
    });
    expect(result.releases.map(row => row.id)).toEqual([2, 1]);
    expect(result.status).toEqual({ lastCronAt: timestamp, projectCount: 2, activeSubscriptions: 1, errorProjects: 1, intervalMinutes: 30 });
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('returns explicit field allowlists and canonical GitHub links without notification or configuration data', async () => {
    const source = await seedProject('owner/public');
    await seedRelease(source.projectId, 1);
    await bindings.DB.prepare('INSERT INTO deliveries(release_id,chat_id,created_at,error) VALUES(1,?,?,?)')
      .bind('super-secret-chat', timestamp, 'private-delivery-error').run();
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('default_chat_id','super-secret-chat')").run();
    const result = await getPublicDashboard(bindings);
    expect(Object.keys(result).sort()).toEqual(['releases', 'status', 'subscriptions']);
    expect(Object.keys(result.subscriptions[0]).sort()).toEqual([
      'coverUrl', 'error', 'id', 'includePrerelease', 'initialized', 'intervalMinutes', 'lastCheckedAt', 'lastSuccessAt',
      'latestTag', 'latestUrl', 'nextCheckAt', 'paused', 'projectId', 'repo',
    ].sort());
    expect(Object.keys(result.releases[0]).sort()).toEqual([
      'body', 'coverUrl', 'discoveredAt', 'id', 'name', 'prerelease', 'projectId', 'publishedAt', 'repo', 'tag', 'url',
    ].sort());
    expect(Object.keys(result.status).sort()).toEqual(['activeSubscriptions', 'errorProjects', 'intervalMinutes', 'lastCronAt', 'projectCount']);
    expect(result.releases[0]).toMatchObject({ body: 'Release notes', prerelease: false, url: 'https://github.com/owner/public/releases/tag/v1' });
    expect(JSON.stringify(result)).not.toMatch(/super-secret|delivery|Configured|Bound|chatId|errorCount|createdAt|untrusted/);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('filters private history and excluded prereleases before applying the timeline limit', async () => {
    const visible = await seedProject('owner/public');
    const hidden = await seedProject('owner/private', 0);
    await seedRelease(visible.projectId, 1);
    for (let i = 2; i <= 56; i++) await seedRelease(hidden.projectId, i, false, timestamp);
    await seedRelease(visible.projectId, 100, true, timestamp);
    const result = await getPublicDashboard(bindings);
    expect(result.releases.map(row => row.id)).toEqual([1]);
    expect(result.subscriptions[0].latestTag).toBe('v1');
    for (let i = 200; i < 251; i++) await seedRelease(visible.projectId, i);
    const limited = await getPublicDashboard(bindings);
    expect(limited.releases).toHaveLength(50);
    expect(limited.releases[0].id).toBe(250);
    expect(limited.releases[49].id).toBe(201);
  });
});

describe('visibility refresh during release checks', () => {
  it('withdraws historical data when a public repository becomes private without losing the baseline', async () => {
    const subscription = await addSubscription(bindings, { repo: 'owner/public', chatId: '12345' });
    await seedRelease(subscription.projectId, 1);
    await bindings.DB.prepare('UPDATE projects SET initialized=1,scan_page=8 WHERE id=?').bind(subscription.projectId).run();
    expect((await getPublicDashboard(bindings)).releases).toHaveLength(1);
    upstream.mockImplementation(async input => new URL(String(input)).pathname.endsWith('/releases')
      ? Response.json([]) : Response.json({ private: true }));
    expect(await runChecks(bindings, { projectId: subscription.projectId, force: true })).toEqual({ checked: 1, discovered: 0, errors: 0 });
    expect(await bindings.DB.prepare('SELECT is_public,visibility_checked_at,initialized FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ is_public: 0, visibility_checked_at: timestamp, initialized: 1 });
    expect((await getPublicDashboard(bindings)).releases).toEqual([]);
    expect((await bindings.DB.prepare('SELECT COUNT(*) AS n FROM releases').first<{ n: number }>())!.n).toBe(1);
  });
  it.each([null, [], {}, { private: 'false' }, { private: null }])('hides unconfirmed metadata while continuing the release baseline (%j)', async payload => {
    const subscription = await addSubscription(bindings, { repo: 'owner/public', chatId: '12345' });
    upstream.mockImplementation(async input => new URL(String(input)).pathname.endsWith('/releases')
      ? Response.json([]) : Response.json(payload));
    expect(await runChecks(bindings, { projectId: subscription.projectId, force: true })).toEqual({ checked: 1, discovered: 0, errors: 0 });
    expect((await getPublicDashboard(bindings)).subscriptions).toEqual([]);
    expect(await bindings.DB.prepare('SELECT initialized,is_public FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ initialized: 1, is_public: 0 });
  });
  it.each([403, 429, 404, 503])('withdraws public data and honors existing error handling on metadata HTTP %s', async status => {
    const subscription = await addSubscription(bindings, { repo: 'owner/public', chatId: '12345' });
    await seedRelease(subscription.projectId, 1);
    upstream.mockClear();
    upstream.mockImplementation(async () => Response.json({ message: 'sensitive private upstream body' }, {
      status, headers: { 'Retry-After': '300' },
    }));
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(1);
    expect(upstream).toHaveBeenCalledTimes(1);
    const project = await bindings.DB.prepare('SELECT is_public,error,error_count,next_check_at FROM projects WHERE id=?')
      .bind(subscription.projectId).first<{ is_public: number; error: string; error_count: number; next_check_at: string }>();
    expect(project).toMatchObject({ is_public: 0, error_count: 1 });
    expect(project!.error).not.toContain('sensitive');
    expect(Date.parse(project!.next_check_at)).toBeGreaterThanOrEqual(now + ([403, 429].includes(status) ? 300_000 : 60_000));
    expect((await getPublicDashboard(bindings)).releases).toEqual([]);
  });
  it('hides metadata network failures and restores visibility only after a successful fresh verification', async () => {
    const subscription = await addSubscription(bindings, { repo: 'owner/public', chatId: '12345' });
    upstream.mockRejectedValue(new Error('network secret'));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect((await getPublicDashboard(bindings)).subscriptions).toEqual([]);
    upstream.mockImplementation(async input => new URL(String(input)).pathname.endsWith('/releases')
      ? Response.json([]) : Response.json({ private: false }));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect((await getPublicDashboard(bindings)).subscriptions).toHaveLength(1);
  });
  it('refreshes visibility even when the release head returns 304 and preserves history scanning', async () => {
    const subscription = await addSubscription(bindings, { repo: 'owner/public', chatId: '12345' });
    await bindings.DB.prepare('UPDATE projects SET is_public=0,etag=?,scan_page=8 WHERE id=?').bind('"cached"', subscription.projectId).run();
    upstream.mockImplementation(async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/releases')) return Response.json({ private: false });
      return url.searchParams.get('page') === '1' ? new Response(null, { status: 304 }) : Response.json([]);
    });
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(0);
    expect((await getPublicDashboard(bindings)).subscriptions[0]).toMatchObject({ initialized: true });
    expect(upstream.mock.calls.some(([url]) => new URL(String(url)).searchParams.get('page') === '8')).toBe(true);
  });
});
