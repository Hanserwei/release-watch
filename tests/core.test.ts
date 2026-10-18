import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initializeTestSchema } from './schema';
import type { Env } from '../src/server/env';
import { addSubscription, bindDefaultChat, listSubscriptions, removeSubscription, updateSubscription } from '../src/server/subscriptions';
import { normalizeRepo } from '../src/server/github';
import { runChecks } from '../src/server/poller';
import { deliverPending } from '../src/server/deliveries';
import { getStatus, listReleases, retryFailedDeliveries } from '../src/server/queries';

const bindings = env as unknown as Env;
const old = '2020-01-01T00:00:00.000Z';
interface ReleaseFixture { id: number; tag_name: string; name: string; body: string; draft: boolean; prerelease: boolean; published_at: string; }
function release(id: number, prerelease = false, published = old) {
  return { id, tag_name: `v${id}`, name: `Release ${id}`, body: 'Release notes', draft: false, prerelease, published_at: published };
}
function page(items: ReleaseFixture[], hasNext = false, etag = '"head"'): Response {
  return Response.json(items, { headers: { ETag: etag, ...(hasNext ? { Link: '<https://api.github.com/repos/owner/repo/releases?page=999>; rel="next"' } : {}) } });
}
async function create(chatId = '12345', includePrerelease = false) {
  return addSubscription(bindings, { repo: 'Owner/Repo', chatId, includePrerelease });
}
async function count(table: 'projects' | 'subscriptions' | 'releases' | 'deliveries'): Promise<number> {
  const row = await bindings.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}
// Run another request at a deterministic transaction boundary, using the real D1 database.
function interleaveBatch(action: () => Promise<void>, when: 'before' | 'after' = 'before'): Env {
  let pending = true;
  const DB = new Proxy(bindings.DB, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        const interleave = pending;
        pending = false;
        if (interleave && when === 'before') await action();
        const result = await target.batch(statements);
        if (interleave && when === 'after') await action();
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...bindings, DB };
}
let fetchMock: Mock<typeof fetch>;
beforeAll(async () => {
  await initializeTestSchema(bindings.DB);
});
beforeEach(async () => {
  await bindings.DB.batch(['subscription_release_skips', 'deliveries', 'releases', 'subscriptions', 'projects', 'settings', 'chat_delivery_locks', 'telegram_updates'].map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
  fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: 1, private: false }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('repository and subscription contracts', () => {
  it('uses a Workers-compatible request and refuses GitHub redirects before saving a subscription', async () => {
    const outboundRequests: Request[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      outboundRequests.push(new Request(input, init));
      return new Response(null, { status: 302, headers: { Location: 'https://example.com/untrusted' } });
    });
    await expect(create()).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0].redirect).toBe('manual');
    expect(await count('subscriptions')).toBe(0);
  });
  it('normalizes only a repository path or an exact GitHub HTTPS repository link', () => {
    expect(normalizeRepo(' Owner/Repo ')).toBe('owner/repo');
    expect(normalizeRepo('https://github.com/Owner/Repo.git/')).toBe('owner/repo');
    for (const input of ['https://evil.test/owner/repo', 'http://github.com/owner/repo', 'https://github.com.evil.test/owner/repo', 'https://github.com@evil.test/owner/repo', 'https://github.com/owner/repo/releases', 'https://github.com/owner/repo?x=y', 'https://github.com/owner/repo#x', 'owner/../repo', 'owner/%2erepo', 'https://github.com/owner/repo/../other', 'owner/repo/extra']) {
      expect(() => normalizeRepo(input), input).toThrow();
    }
  });
  it('reuses a project, makes target subscriptions unique, and leaves existing settings intact', async () => {
    const first = await create('1');
    const duplicate = await addSubscription(bindings, { repo: 'https://github.com/OWNER/REPO', chatId: '1', includePrerelease: true });
    const second = await create('2', true);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.includePrerelease).toBe(false);
    expect(first.projectId).toBe(second.projectId);
    expect(first.intervalMinutes).toBe(15);
    expect(await count('projects')).toBe(1);
    expect(await count('subscriptions')).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await listSubscriptions(bindings, '1')).toHaveLength(1);
    await expect(removeSubscription(bindings, second.id, '1')).rejects.toMatchObject({ status: 404 });
    await expect(updateSubscription(bindings, first.id, { intervalMinutes: 7 })).rejects.toThrow();
  });
  it('returns the subscription written before a concurrent default-chat change without overwriting duplicate options', async () => {
    const first = await create('1');
    await create('2', true);
    await bindDefaultChat(bindings, '1');
    const concurrentEnv = interleaveBatch(() => bindDefaultChat(bindings, '2'), 'after');
    const duplicate = await addSubscription(concurrentEnv, { repo: 'owner/repo', includePrerelease: true, intervalMinutes: 360 });
    expect(duplicate).toMatchObject({ id: first.id, chatId: '1', includePrerelease: false, intervalMinutes: 15 });
    expect((await getStatus(bindings)).defaultChatId).toBe('2');
    expect(await count('subscriptions')).toBe(2);
  });
  it('returns the same unbound subscription on duplicate creation and after a concurrent /start binding', async () => {
    const webEnv = { ...bindings, TELEGRAM_CHAT_ID: undefined };
    const first = await addSubscription(webEnv, { repo: 'owner/repo' });
    const duplicate = await addSubscription(webEnv, { repo: 'owner/repo', includePrerelease: true, intervalMinutes: 360 });
    expect(duplicate).toMatchObject({ id: first.id, chatId: null, includePrerelease: false, intervalMinutes: 15 });
    const concurrentEnv = { ...interleaveBatch(() => bindDefaultChat(webEnv, '9'), 'after'), TELEGRAM_CHAT_ID: undefined };
    expect(await addSubscription(concurrentEnv, { repo: 'owner/repo' })).toMatchObject({ id: first.id, chatId: '9' });
    expect(await count('subscriptions')).toBe(1);
  });
  it.each(['pause', 'interval'] as const)('preserves both concurrent pause and interval patches when %s commits last', async last => {
    const subscription = await create();
    await bindings.DB.prepare('UPDATE subscriptions SET notify_after=? WHERE id=?').bind(old, subscription.id).run();
    const pause = { paused: true };
    const interval = { intervalMinutes: 60 };
    const concurrentEnv = interleaveBatch(async () => {
      await updateSubscription(bindings, subscription.id, last === 'pause' ? interval : pause);
    });
    await updateSubscription(concurrentEnv, subscription.id, last === 'pause' ? pause : interval);
    expect((await listSubscriptions(bindings))[0]).toMatchObject({ paused: true, intervalMinutes: 60 });
    expect(await bindings.DB.prepare('SELECT notify_after FROM subscriptions WHERE id=?').bind(subscription.id).first()).toEqual({ notify_after: old });
  });
  it('uses the actual old paused state when a resume races with a pause after its initial read', async () => {
    const subscription = await create();
    await bindings.DB.prepare('UPDATE subscriptions SET notify_after=? WHERE id=?').bind(old, subscription.id).run();
    const now = Date.now() + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const concurrentEnv = interleaveBatch(async () => {
      await updateSubscription(bindings, subscription.id, { paused: true, includePrerelease: true, intervalMinutes: 60 });
    });
    const resumed = await updateSubscription(concurrentEnv, subscription.id, { paused: false });
    expect(resumed).toMatchObject({ paused: false, includePrerelease: true, intervalMinutes: 60 });
    expect(await bindings.DB.prepare('SELECT notify_after,promotion_generation FROM subscriptions WHERE id=?').bind(subscription.id).first())
      .toEqual({ notify_after: new Date(now).toISOString(), promotion_generation: 0 });
  });
  it('reports nonexistent repositories without storing credentials or upstream payload', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'secret-token raw-private-body' }, { status: 404 }));
    await expect(create()).rejects.toMatchObject({ status: 404, message: 'GitHub 仓库不存在，或当前凭据无权访问' });
    expect(await count('projects')).toBe(0);
    await expect(runChecks(bindings, { projectId: 999, force: true })).rejects.toMatchObject({ status: 404 });
  });
  it('saves a web subscription before /start and binds its eligible outbox without historical delivery', async () => {
    const webEnv = { ...bindings, TELEGRAM_CHAT_ID: undefined };
    const subscription = await addSubscription(webEnv, { repo: 'owner/repo' });
    expect(subscription.chatId).toBeNull();
    const published = new Date(Date.now() + 1000).toISOString();
    fetchMock.mockImplementation(async () => page([release(2, false, published), release(1)]));
    await runChecks(webEnv, { projectId: subscription.projectId, force: true });
    expect(await count('deliveries')).toBe(0);
    await bindDefaultChat(webEnv, '9');
    expect((await listSubscriptions(webEnv))[0].chatId).toBe('9');
    expect((await getStatus(webEnv)).defaultChatId).toBe('9');
    const rows = await bindings.DB.prepare('SELECT release_id,chat_id FROM deliveries').all();
    expect(rows.results).toEqual([{ release_id: 2, chat_id: '9' }]);
    const later = await addSubscription(webEnv, { repo: 'other/project' });
    expect(later.chatId).toBe('9');
  });
  it('records verified creation visibility and preserves it when another chat reuses the project', async () => {
    const first = await create('1');
    const metadata = await bindings.DB.prepare('SELECT is_public,visibility_checked_at FROM projects WHERE id=?')
      .bind(first.projectId).first<{ is_public: number; visibility_checked_at: string }>();
    expect(metadata!.is_public).toBe(1);
    expect(Date.parse(metadata!.visibility_checked_at)).toBeGreaterThan(0);
    fetchMock.mockImplementation(async () => Response.json({ private: true }));
    await create('2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await bindings.DB.prepare('SELECT is_public,visibility_checked_at FROM projects WHERE id=?').bind(first.projectId).first()).toEqual(metadata);
  });
  it.each([true, undefined, 'false'])('keeps private or unconfirmed creation metadata hidden (%s)', async privateValue => {
    fetchMock.mockImplementation(async () => Response.json({ private: privateValue }));
    const subscription = await create();
    expect(await bindings.DB.prepare('SELECT is_public FROM projects WHERE id=?').bind(subscription.projectId).first()).toEqual({ is_public: 0 });
    expect(subscription.initialized).toBe(false);
  });
});

describe('persistent release scans', () => {
  it('stores a baseline, initializes empty repos, and only queues releases published after subscription', async () => {
    const subscription = await create();
    fetchMock.mockImplementation(async () => page([release(1)]));
    expect(await runChecks(bindings, { projectId: subscription.projectId, force: true })).toEqual({ checked: 1, discovered: 1, errors: 0 });
    expect(await count('deliveries')).toBe(0);
    expect((await listSubscriptions(bindings))[0].initialized).toBe(true);
    const published = new Date(Date.now() + 1000).toISOString();
    fetchMock.mockImplementation(async () => page([release(3, false, published), release(2, false, published), release(1)]));
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).discovered).toBe(2);
    expect(await count('deliveries')).toBe(2);
    expect((await listReleases(bindings))[0].deliveryStatus).toBe('pending');
    const empty = await addSubscription(bindings, { repo: 'empty/repo', chatId: '8' });
    fetchMock.mockImplementation(async () => page([]));
    await runChecks(bindings, { projectId: empty.projectId, force: true });
    expect((await listSubscriptions(bindings, '8'))[0].initialized).toBe(true);
  });
  it('establishes a large repository baseline immediately and still discovers new releases on deeper pages', async () => {
    const subscription = await create();
    const historicalHead = Array.from({ length: 15 }, (_, i) => release(i + 100));
    let newer = false;
    let headNotModified = false;
    const published = new Date(Date.now() + 1000).toISOString();
    fetchMock.mockImplementation(async input => {
      const pageNumber = Number(new URL(String(input)).searchParams.get('page'));
      if (pageNumber === 1) return headNotModified ? new Response(null, { status: 304 }) : page(historicalHead, true);
      const items = Array.from({ length: 15 }, (_, i) => release(pageNumber * 1000 + i));
      if (newer) items[0] = release(99999, false, published);
      return page(items, true);
    });
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(0);
    expect((await listSubscriptions(bindings))[0]).toMatchObject({ initialized: true, latestTag: 'v2014' });
    expect(await bindings.DB.prepare('SELECT scan_page,sweep_generation FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ scan_page: 3, sweep_generation: 0 });
    expect(await count('deliveries')).toBe(0);
    newer = true; headNotModified = true;
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(0);
    expect((await bindings.DB.prepare('SELECT release_id FROM deliveries').all()).results).toEqual([{ release_id: 99999 }]);
    expect(await bindings.DB.prepare('SELECT initialized,scan_page FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ initialized: 1, scan_page: 4 });
  });
  it('repairs an existing unfinished baseline on a 304 without resetting its history cursor or notifying history', async () => {
    const subscription = await create();
    await bindings.DB.prepare('UPDATE projects SET etag=?,scan_page=8,initialized=0 WHERE id=?')
      .bind('"cached-head"', subscription.projectId).run();
    fetchMock.mockImplementation(async input => Number(new URL(String(input)).searchParams.get('page')) === 1
      ? new Response(null, { status: 304 }) : page([release(1)], true));
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(0);
    expect(await bindings.DB.prepare('SELECT initialized,scan_page,sweep_generation FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ initialized: 1, scan_page: 9, sweep_generation: 0 });
    expect(await count('deliveries')).toBe(0);
  });
  it('keeps a cached latest-page baseline ready even when a historical page fails', async () => {
    const subscription = await create();
    await bindings.DB.prepare('UPDATE projects SET etag=?,scan_page=8,initialized=0 WHERE id=?')
      .bind('"cached-head"', subscription.projectId).run();
    fetchMock.mockImplementation(async input => {
      if (!new URL(String(input)).pathname.endsWith('/releases')) return Response.json({ private: false });
      return Number(new URL(String(input)).searchParams.get('page')) === 1
        ? new Response(null, { status: 304 }) : new Response(null, { status: 503 });
    });
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(1);
    expect(await bindings.DB.prepare('SELECT initialized,scan_page FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ initialized: 1, scan_page: 8 });
    expect(await count('deliveries')).toBe(0);
  });
  it('does not mark a baseline ready when the first latest-page fetch fails', async () => {
    const subscription = await create();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(1);
    expect((await listSubscriptions(bindings))[0].initialized).toBe(false);
    expect(await count('releases')).toBe(0);
  });
  it('persists a multipage cursor, retries failed old pages, and continues them when head returns 304', async () => {
    const subscription = await create();
    const headItems = Array.from({ length: 15 }, (_, i) => release(i + 100));
    fetchMock.mockImplementation(async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/releases')) return Response.json({ private: false });
      if (url.searchParams.get('page') === '1') return page(headItems, true);
      return Response.json({ message: 'private body' }, { status: 500 });
    });
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(1);
    const failed = await bindings.DB.prepare('SELECT scan_page,initialized,etag,error FROM projects WHERE id=?').bind(subscription.projectId).first();
    expect(failed).toMatchObject({ scan_page: 2, initialized: 1, etag: '"head"' });
    expect(String(failed!.error)).not.toContain('private body');
    expect(await count('deliveries')).toBe(0);
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.redirect).toBe('manual');
      const h = new Headers(init?.headers);
      expect(h.get('Authorization')).toBe('Bearer test-github-token');
      if (url.searchParams.get('page') === '1') {
        expect(h.get('If-None-Match')).toBe('"head"');
        return new Response(null, { status: 304 });
      }
      return page(Array.from({ length: 15 }, (_, i) => release(i + 50)), true);
    });
    expect((await runChecks(bindings, { projectId: subscription.projectId, force: true })).errors).toBe(0);
    expect(await bindings.DB.prepare('SELECT scan_page,initialized FROM projects WHERE id=?').bind(subscription.projectId).first()).toEqual({ scan_page: 3, initialized: 1 });
    fetchMock.mockImplementation(async input => new URL(String(input)).searchParams.get('page') === '1' ? new Response(null, { status: 304 }) : page([release(1)]));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect(await bindings.DB.prepare('SELECT scan_page,initialized,error_count FROM projects WHERE id=?').bind(subscription.projectId).first()).toEqual({ scan_page: 2, initialized: 1, error_count: 0 });
    expect(await count('releases')).toBe(31);
    expect(await count('deliveries')).toBe(0);
  });
  it('notifies formal subscribers about an old-page prerelease promotion despite head 304, once per chat/release', async () => {
    const formal = await create('1');
    await create('2', true);
    const headItems = Array.from({ length: 15 }, (_, i) => release(i + 100));
    let promoted = false;
    let notModified = false;
    fetchMock.mockImplementation(async input => {
      if (new URL(String(input)).searchParams.get('page') === '1') return notModified ? new Response(null, { status: 304 }) : page(headItems, true);
      return page([release(1, !promoted)]);
    });
    await runChecks(bindings, { projectId: formal.projectId, force: true });
    expect(await count('deliveries')).toBe(0);
    // Even a subscriber created after the original prerelease date receives the conversion.
    await create('3');
    promoted = true; notModified = true;
    await runChecks(bindings, { projectId: formal.projectId, force: true });
    await runChecks(bindings, { projectId: formal.projectId, force: true });
    const rows = await bindings.DB.prepare('SELECT chat_id,release_id FROM deliveries ORDER BY chat_id').all();
    expect(rows.results).toEqual([{ chat_id: '1', release_id: 1 }, { chat_id: '2', release_id: 1 }, { chat_id: '3', release_id: 1 }]);
  });
  it('does not send a second notification when a notified prerelease becomes formal', async () => {
    const pre = await create('1', true);
    await create('2');
    const published = new Date(Date.now() + 1000).toISOString();
    fetchMock.mockImplementation(async () => page([release(1, true, published)]));
    await runChecks(bindings, { projectId: pre.projectId, force: true });
    fetchMock.mockImplementation(async () => page([release(1, false, published)]));
    await runChecks(bindings, { projectId: pre.projectId, force: true });
    expect(await count('deliveries')).toBe(2);
    expect((await bindings.DB.prepare('SELECT chat_id FROM deliveries ORDER BY chat_id').all()).results).toEqual([{ chat_id: '1' }, { chat_id: '2' }]);
  });
  it('does not reset a shared baseline or deliver already-published versions to a later subscriber', async () => {
    const first = await create('1');
    const between = new Date(Date.now() - 1000).toISOString();
    await bindings.DB.prepare('UPDATE subscriptions SET notify_after=?,created_at=? WHERE id=?').bind(old, old, first.id).run();
    fetchMock.mockImplementation(async () => page([release(1, false, between)]));
    await runChecks(bindings, { projectId: first.projectId, force: true });
    await create('2');
    fetchMock.mockImplementation(async () => page([release(2, false, between), release(1, false, between)]));
    await runChecks(bindings, { projectId: first.projectId, force: true });
    expect((await bindings.DB.prepare('SELECT chat_id,release_id FROM deliveries ORDER BY release_id').all()).results).toEqual([{ chat_id: '1', release_id: 1 }, { chat_id: '1', release_id: 2 }]);
  });
  it('does not backfill promotions observed while paused or releases published during a pause', async () => {
    const subscription = await create();
    fetchMock.mockImplementation(async () => page([release(1, true)]));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    await updateSubscription(bindings, subscription.id, { paused: true });
    const duringPause = new Date(Date.now() - 1000).toISOString();
    fetchMock.mockImplementation(async () => page([release(2, false, duringPause), release(1, false)]));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect((await bindings.DB.prepare('SELECT subscription_id,release_id FROM subscription_release_skips').all()).results)
      .toEqual([{ subscription_id: subscription.id, release_id: 1 }]);
    await updateSubscription(bindings, subscription.id, { paused: false });
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect(await count('deliveries')).toBe(0);
    fetchMock.mockImplementation(async () => page([release(3, false, new Date(Date.now() + 1000).toISOString()), release(2, false, duringPause), release(1, false)]));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect((await bindings.DB.prepare('SELECT release_id FROM deliveries').all()).results).toEqual([{ release_id: 3 }]);
  });
  it('notifies a genuinely new promotion after resume while the old-page sweep is still in progress', async () => {
    const subscription = await create();
    const headItems = Array.from({ length: 15 }, (_, i) => release(i + 100));
    let promoted = false;
    let notModified = false;
    fetchMock.mockImplementation(async input => {
      const pageNumber = new URL(String(input)).searchParams.get('page');
      if (pageNumber === '1') return notModified ? new Response(null, { status: 304 }) : page(headItems, true);
      if (pageNumber === '2') return page([release(1, !promoted)], true);
      return page([release(2, true)]);
    });
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect(await bindings.DB.prepare('SELECT scan_page,sweep_generation FROM projects WHERE id=?').bind(subscription.projectId).first())
      .toEqual({ scan_page: 3, sweep_generation: 0 });
    await updateSubscription(bindings, subscription.id, { paused: true });
    await updateSubscription(bindings, subscription.id, { paused: false });
    promoted = true;
    notModified = true;
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect((await bindings.DB.prepare('SELECT chat_id,release_id FROM deliveries').all()).results)
      .toEqual([{ chat_id: '12345', release_id: 1 }]);
    expect((await bindings.DB.prepare('SELECT * FROM subscription_release_skips').all()).results).toEqual([]);
  });
  it('notifies a promotion first observed after resume without a generation-based rescan delay', async () => {
    const subscription = await create();
    fetchMock.mockImplementation(async () => page([release(1, true)]));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    await updateSubscription(bindings, subscription.id, { paused: true });
    await updateSubscription(bindings, subscription.id, { paused: false });
    fetchMock.mockImplementation(async () => page([release(1, false)]));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    expect((await bindings.DB.prepare('SELECT release_id FROM deliveries').all()).results).toEqual([{ release_id: 1 }]);
  });
  it.each([403, 429])('respects HTTP %s reset and Retry-After and applies persistent exponential backoff', async status => {
    const subscription = await create();
    const reset = Math.ceil(Date.now() / 1000) + 900;
    fetchMock.mockResolvedValue(Response.json({ message: 'sensitive-token-and-body' }, { status, headers: { 'Retry-After': '300', 'X-RateLimit-Reset': String(reset) } }));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    const row = await bindings.DB.prepare('SELECT next_check_at,error,error_count,lease_until FROM projects WHERE id=?').bind(subscription.projectId).first<{ next_check_at: string; error: string; error_count: number; lease_until: number }>();
    expect(Date.parse(row!.next_check_at)).toBeGreaterThanOrEqual(reset * 1000);
    expect(row).toMatchObject({ error_count: 1, lease_until: 0 });
    expect(row!.error).not.toContain('sensitive');
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    await runChecks(bindings, { projectId: subscription.projectId, force: true });
    const next = await bindings.DB.prepare('SELECT error_count,next_check_at FROM projects WHERE id=?').bind(subscription.projectId).first<{ error_count: number; next_check_at: string }>();
    expect(next!.error_count).toBe(2);
    expect(Date.parse(next!.next_check_at)).toBeGreaterThan(Date.now() + 110_000);
  });
  it('claims one project atomically across concurrent checks and refuses a stolen lease', async () => {
    const subscription = await create();
    let entered!: () => void;
    let unblock!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const block = new Promise<void>(resolve => { unblock = resolve; });
    fetchMock.mockImplementation(async () => { entered(); await block; return page([release(1, false, new Date(Date.now() + 1000).toISOString())]); });
    const first = runChecks(bindings, { projectId: subscription.projectId, force: true });
    await enteredPromise;
    expect(await runChecks(bindings, { projectId: subscription.projectId, force: true })).toEqual({ checked: 0, discovered: 0, errors: 0 });
    // Simulate expiration/reclaim before the first network call completes.
    await bindings.DB.prepare('UPDATE projects SET lease_token=?,lease_until=? WHERE id=?').bind('replacement', Date.now() + 90_000, subscription.projectId).run();
    unblock();
    await first;
    expect(await count('releases')).toBe(0);
    expect(await count('deliveries')).toBe(0);
    expect(await bindings.DB.prepare('SELECT lease_token FROM projects WHERE id=?').bind(subscription.projectId).first()).toEqual({ lease_token: 'replacement' });
  });
  it('concurrent successful checks create only one outbox row', async () => {
    const subscription = await create();
    fetchMock.mockImplementation(async () => page([release(1, false, new Date(Date.now() + 1000).toISOString())]));
    await Promise.all(Array.from({ length: 4 }, () => runChecks(bindings, { projectId: subscription.projectId, force: true })));
    expect(await count('releases')).toBe(1);
    expect(await count('deliveries')).toBe(1);
  });
  it('defaults to three due projects per tick', async () => {
    for (let i = 0; i < 5; i++) await addSubscription(bindings, { repo: `owner/repo${i}`, chatId: '1' });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async input => new URL(String(input)).pathname.endsWith('/releases') ? page([]) : Response.json({ private: false }));
    expect((await runChecks({ ...bindings, POLL_BATCH_SIZE: undefined })).checked).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it('keeps three projects with two full pages plus one delivery below 50 D1 statements', async () => {
    for (let i = 0; i < 3; i++) await addSubscription(bindings, { repo: `owner/repo${i}`, chatId: String(i + 1) });
    const published = new Date(Date.now() + 1000).toISOString();
    fetchMock.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.hostname === 'api.telegram.org') return Response.json({ ok: true, result: { message_id: 100 } });
      if (!url.pathname.endsWith('/releases')) return Response.json({ private: false });
      const repoIndex = Number(/repo(\d+)/.exec(url.pathname)![1]);
      const pageNumber = Number(url.searchParams.get('page'));
      return page(Array.from({ length: 15 }, (_, i) => release(repoIndex * 1000 + pageNumber * 100 + i, false, published)), true);
    });
    let statements = 0;
    const meteredDB = new Proxy(bindings.DB, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => { statements++; return target.prepare(sql); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const meteredEnv = { ...bindings, DB: meteredDB, POLL_BATCH_SIZE: '99', DELIVERY_BATCH_SIZE: '99' };
    await meteredDB.prepare("INSERT INTO settings(key,value) VALUES('last_cron_at',?)").bind(new Date().toISOString()).run();
    expect((await runChecks(meteredEnv)).checked).toBe(3);
    expect((await deliverPending(meteredEnv)).sent).toBe(1);
    expect(statements).toBeLessThanOrEqual(50);
    expect(await count('releases')).toBe(90);
  });
});

async function seedOutbox(chatId = '12345', releases = 1): Promise<void> {
  const subscription = await create(chatId);
  const published = new Date(Date.now() + 1000).toISOString();
  fetchMock.mockImplementation(async () => page(Array.from({ length: releases }, (_, i) => release(i + 1, false, published))));
  await runChecks(bindings, { projectId: subscription.projectId, force: true });
  fetchMock.mockReset();
}
describe('durable deliveries', () => {
  it.each(['pause', 'remove'] as const)('%s cancels every unsent state for only the matching chat and project', async action => {
    await seedOutbox('12345', 5);
    const subscription = (await listSubscriptions(bindings, '12345'))[0];
    await create('2');
    fetchMock.mockResolvedValue(Response.json({ id: 1 }));
    const otherProject = await addSubscription(bindings, { repo: 'other/project', chatId: '12345' });
    await bindings.DB.batch([
      bindings.DB.prepare(`UPDATE deliveries SET status=CASE release_id WHEN 1 THEN 'pending' WHEN 2 THEN 'failed'
        WHEN 3 THEN 'sending' WHEN 4 THEN 'sending' ELSE 'sent' END,
        lease_until=CASE WHEN release_id=4 THEN ? ELSE 0 END`).bind(Date.now() + 30_000),
      bindings.DB.prepare("INSERT INTO deliveries(release_id,chat_id,created_at) SELECT id,'2',? FROM releases").bind(old),
      bindings.DB.prepare(`INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token)
        VALUES(99,?,'v99','Other release','https://github.com/other/project/releases/tag/v99','',0,?,?,?,'fixture')`)
        .bind(otherProject.projectId, old, old, new Date(Date.now() + 1000).toISOString()),
      bindings.DB.prepare("INSERT INTO deliveries(release_id,chat_id,created_at) VALUES(99,'12345',?)").bind(old),
    ]);
    if (action === 'pause') await updateSubscription(bindings, subscription.id, { paused: true });
    else await removeSubscription(bindings, subscription.id);
    expect((await bindings.DB.prepare("SELECT release_id,status FROM deliveries WHERE chat_id='12345' ORDER BY release_id").all()).results)
      .toEqual([{ release_id: 5, status: 'sent' }, { release_id: 99, status: 'pending' }]);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE chat_id='2'").first()).toEqual({ n: 5 });
  });
  it.each(['orphan', 'paused', 'prerelease', 'baseline', 'skip'] as const)('cleans %s deliveries in every unsent state before recovering an expired sending lease', async reason => {
    await seedOutbox('12345', 5);
    await bindings.DB.prepare(`UPDATE deliveries SET status=CASE release_id WHEN 1 THEN 'pending' WHEN 2 THEN 'failed'
      WHEN 3 THEN 'sending' WHEN 4 THEN 'sending' ELSE 'sent' END,
      attempts=CASE WHEN release_id=3 THEN 8 ELSE 0 END,
      lease_until=CASE WHEN release_id=4 THEN ? ELSE 0 END`).bind(Date.now() + 30_000).run();
    if (reason === 'orphan') await bindings.DB.prepare('DELETE FROM subscriptions').run();
    if (reason === 'paused') await bindings.DB.prepare('UPDATE subscriptions SET paused=1').run();
    if (reason === 'prerelease') await bindings.DB.prepare('UPDATE releases SET prerelease=1').run();
    if (reason === 'baseline') await bindings.DB.prepare('UPDATE subscriptions SET notify_after=?').bind('2099-01-01T00:00:00.000Z').run();
    if (reason === 'skip') await bindings.DB.prepare(`INSERT INTO subscription_release_skips(subscription_id,release_id)
      SELECT s.id,r.id FROM subscriptions s JOIN releases r ON r.project_id=s.project_id`).run();
    expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await bindings.DB.prepare('SELECT release_id,status FROM deliveries').all()).results).toEqual([{ release_id: 5, status: 'sent' }]);
  });
  it.each(['paused', 'orphan', 'prerelease'] as const)('skips %s work invalidated after cleanup so the next eligible chat can send', async reason => {
    await create('1', true);
    await create('2', true);
    await seedOutbox('1');
    await bindings.DB.prepare("UPDATE deliveries SET next_attempt_at=CASE chat_id WHEN '1' THEN 0 ELSE 1 END").run();
    if (reason === 'prerelease') await bindings.DB.prepare('UPDATE releases SET prerelease=1').run();
    const DB = new Proxy(bindings.DB, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("status!='sent' AND NOT")) return statement;
          return new Proxy(statement, {
            get(prepared, method) {
              if (method === 'run') return async () => {
                const result = await prepared.run();
                if (reason === 'paused') await bindings.DB.prepare("UPDATE subscriptions SET paused=1 WHERE chat_id='1'").run();
                if (reason === 'orphan') await bindings.DB.prepare("DELETE FROM subscriptions WHERE chat_id='1'").run();
                if (reason === 'prerelease') await bindings.DB.prepare("UPDATE subscriptions SET include_prerelease=0 WHERE chat_id='1'").run();
                return result;
              };
              const value = Reflect.get(prepared, method, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    fetchMock.mockResolvedValue(Response.json({ ok: true, result: { message_id: 42 } }));
    expect(await deliverPending({ ...bindings, DB })).toEqual({ sent: 1, failed: 0 });
    expect((await bindings.DB.prepare("SELECT chat_id FROM deliveries WHERE status='sent'").all()).results).toEqual([{ chat_id: '2' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each((['before', 'after'] as const).flatMap(when =>
    (['paused', 'orphan', 'prerelease'] as const).map(reason => ({ when, reason }))))
    ('rejects $reason work invalidated $when the claim transaction', async ({ when, reason }) => {
      await seedOutbox();
      if (reason === 'prerelease') await bindings.DB.batch([
        bindings.DB.prepare('UPDATE releases SET prerelease=1'),
        bindings.DB.prepare('UPDATE subscriptions SET include_prerelease=1'),
      ]);
      const concurrentEnv = interleaveBatch(async () => {
        // Bypass subscription cancellation to prove the delivery guards reject stale work.
        if (reason === 'paused') await bindings.DB.prepare('UPDATE subscriptions SET paused=1').run();
        if (reason === 'orphan') await bindings.DB.prepare('DELETE FROM subscriptions').run();
        if (reason === 'prerelease') await bindings.DB.prepare('UPDATE subscriptions SET include_prerelease=0').run();
      }, when);
      expect(await deliverPending(concurrentEnv)).toEqual({ sent: 0, failed: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
      if (when === 'before') {
        expect(await bindings.DB.prepare('SELECT status,attempts FROM deliveries').first()).toEqual({ status: 'pending', attempts: 0 });
      } else {
        expect(await count('deliveries')).toBe(0);
      }
      expect(await bindings.DB.prepare('SELECT lease_token,lease_until FROM chat_delivery_locks').first()).toEqual({ lease_token: null, lease_until: 0 });
      await deliverPending(bindings);
      expect(await count('deliveries')).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  it('does not recover a cancelled sending lease after an in-flight send finishes', async () => {
    await seedOutbox();
    const subscription = (await listSubscriptions(bindings))[0];
    let entered!: () => void;
    let unblock!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    fetchMock.mockImplementation(async () => {
      entered();
      await blocked;
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    const delivery = deliverPending(bindings);
    await sending;
    try {
      await updateSubscription(bindings, subscription.id, { paused: true });
      expect(await count('deliveries')).toBe(0);
    } finally {
      unblock();
      await delivery;
    }
    await bindings.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=0,lease_until=0').run();
    expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await count('deliveries')).toBe(0);
  });
  it('sends persistent outbox once, records Telegram message id, and serializes a chat', async () => {
    await seedOutbox('12345', 2);
    fetchMock.mockResolvedValue(Response.json({ ok: true, result: { message_id: 42 } }));
    const outcomes = await Promise.all([deliverPending(bindings), deliverPending(bindings)]);
    expect(outcomes.reduce((n, value) => n + value.sent, 0)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await bindings.DB.prepare('SELECT status,message_id FROM deliveries ORDER BY id').all();
    expect(rows.results).toEqual([{ status: 'sent', message_id: 42 }, { status: 'pending', message_id: null }]);
    expect((await getStatus(bindings)).lastDeliveryAt).not.toBeNull();
    await deliverPending(bindings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const lock = await bindings.DB.prepare('SELECT next_send_at FROM chat_delivery_locks WHERE chat_id=?').bind('12345').first<{ next_send_at: number }>();
    expect(lock!.next_send_at).toBeGreaterThan(Date.now());
  });
  it('honors Retry-After and retries an eligible failed attempt without exposing upstream errors', async () => {
    await seedOutbox();
    fetchMock.mockResolvedValue(Response.json({ ok: false, description: 'botSECRET private payload', parameters: { retry_after: 120 } }, { status: 429 }));
    expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 1 });
    const retry = await bindings.DB.prepare('SELECT status,attempts,next_attempt_at,error FROM deliveries').first<{ status: string; attempts: number; next_attempt_at: number; error: string }>();
    expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
    expect(retry!.next_attempt_at).toBeGreaterThan(Date.now() + 110_000);
    expect(retry!.error).not.toContain('SECRET');
    await deliverPending(bindings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await bindings.DB.batch([bindings.DB.prepare('UPDATE deliveries SET next_attempt_at=0'), bindings.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=0')]);
    fetchMock.mockResolvedValue(Response.json({ ok: true, result: { message_id: 9 } }));
    expect(await deliverPending(bindings)).toEqual({ sent: 1, failed: 0 });
    expect(await bindings.DB.prepare('SELECT status,attempts,error FROM deliveries').first()).toEqual({ status: 'sent', attempts: 2, error: null });
  });
  it('retains permanent and exhausted failures, supports manual retry, and recovers expired sending leases', async () => {
    await seedOutbox();
    fetchMock.mockResolvedValue(Response.json({ ok: false, description: 'sensitive' }, { status: 403 }));
    await deliverPending(bindings);
    expect(await bindings.DB.prepare('SELECT status FROM deliveries').first()).toEqual({ status: 'failed' });
    await deliverPending(bindings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await retryFailedDeliveries(bindings);
    await bindings.DB.batch([
      bindings.DB.prepare("UPDATE deliveries SET status='sending',attempts=7,lease_until=0,lease_token='dead-worker'"),
      bindings.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=0,lease_until=0'),
    ]);
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await deliverPending(bindings);
    expect(await bindings.DB.prepare('SELECT status,attempts FROM deliveries').first()).toEqual({ status: 'failed', attempts: 8 });
    await retryFailedDeliveries(bindings);
    await bindings.DB.prepare('UPDATE chat_delivery_locks SET next_send_at=0,lease_until=0').run();
    fetchMock.mockResolvedValue(Response.json({ ok: true, result: { message_id: 10 } }));
    expect((await deliverPending(bindings)).sent).toBe(1);
  });
});
