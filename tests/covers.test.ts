import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/server';
import type { Env } from '../src/server/env';
import { addSubscription, listSubscriptions, updateSubscription } from '../src/server/subscriptions';
import { getPublicDashboard } from '../src/server/public';
import { defaultCoverForRepo } from '../src/shared/covers';
import { initializeTestSchema } from './schema';

const bindings = env as unknown as Env;
const headers = { Authorization: 'Bearer ' + bindings.ADMIN_TOKEN, 'Content-Type': 'application/json' };
let fetchMock: ReturnType<typeof vi.fn>;
const now = Date.parse('2026-10-17T12:00:00.000Z');
const timestamp = new Date(now).toISOString();

async function request(path: string, init: RequestInit = {}) {
  return worker.fetch!(new Request('https://release-watch.example' + path, init), bindings, {} as ExecutionContext);
}
async function coverOf(projectId: number): Promise<string | null> {
  const row = await bindings.DB.prepare('SELECT cover_url FROM projects WHERE id=?').bind(projectId).first<{ cover_url: string | null }>();
  return row?.cover_url ?? null;
}

beforeAll(async () => { await initializeTestSchema(bindings.DB); });
beforeEach(async () => {
  await bindings.DB.batch(['subscription_release_skips', 'deliveries', 'releases', 'subscriptions', 'projects', 'settings', 'telegram_updates', 'chat_delivery_locks']
    .map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  fetchMock = vi.fn(async () => Response.json({ id: 1, private: false }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cover URL validation', () => {
  it.each([
    'http://cdn.example.com/cover.png',
    'ftp://cdn.example.com/cover.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://user:pass@cdn.example.com/cover.png',
    'https://cdn.example.com:8443/cover.png',
    'https://cdn.example.com/cover.png#fragment',
    'https://localhost/cover.png',
    'https://cdn.example.com/cover image.png',
    'https://cdn.example.com/cover\n.png',
    '//cdn.example.com/cover.png',
    '/covers/bad.name.png',
    '/covers/art.svg',
    `https://cdn.example.com/${'a'.repeat(500)}.png`,
  ])('rejects %s', async coverUrl => {
    const response = await request('/api/subscriptions', {
      method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo', coverUrl }),
    });
    expect(response.status).toBe(400);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM projects').first()).toEqual({ n: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a non-string cover and any non-JSON request', async () => {
    expect((await request('/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo', coverUrl: 42 }) })).status).toBe(400);
    expect((await request('/api/subscriptions', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });
  it('accepts an HTTPS image link and normalizes it', async () => {
    const response = await request('/api/subscriptions', {
      method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo', coverUrl: '  https://cdn.example.com/covers/a%20b.png  ' }),
    });
    expect(response.status).toBe(201);
    const { subscription } = await response.json() as { subscription: { coverUrl: string; projectId: number } };
    expect(subscription.coverUrl).toBe('https://cdn.example.com/covers/a%20b.png');
    expect(await coverOf(subscription.projectId)).toBe('https://cdn.example.com/covers/a%20b.png');
  });
  it('accepts a bundled cover path', async () => {
    const response = await request('/api/subscriptions', {
      method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo', coverUrl: '/covers/custom-art.png' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ subscription: { coverUrl: '/covers/custom-art.png' } });
  });
});

describe('cover defaults and retention across duplicate subscriptions', () => {
  it('assigns the built-in cover to a known project and no cover to an unknown one', async () => {
    expect(defaultCoverForRepo('Halo-Dev/Halo')).toBe('/covers/halo.png');
    expect(defaultCoverForRepo('unknown/repo')).toBeNull();
    const known = await addSubscription(bindings, { repo: 'halo-dev/halo', chatId: '12345' });
    expect(known.coverUrl).toBe('/covers/halo.png');
    const other = await addSubscription(bindings, { repo: 'owner/other', chatId: '12345' });
    expect(other.coverUrl).toBeNull();
  });
  it('keeps an existing custom cover when the same project is subscribed again', async () => {
    const first = await addSubscription(bindings, { repo: 'owner/repo', chatId: '1', coverUrl: 'https://cdn.example.com/first.png' });
    const custom = await updateSubscription(bindings, first.id, { coverUrl: 'https://cdn.example.com/custom.png' });
    expect(custom.coverUrl).toBe('https://cdn.example.com/custom.png');
    const duplicate = await addSubscription(bindings, { repo: 'owner/repo', chatId: '2', coverUrl: 'https://cdn.example.com/second.png' });
    expect(duplicate.id).not.toBe(first.id);
    expect(duplicate.coverUrl).toBe('https://cdn.example.com/custom.png');
    expect(await coverOf(first.projectId)).toBe('https://cdn.example.com/custom.png');
  });
  it('fills a missing cover when the project is subscribed again', async () => {
    const first = await addSubscription(bindings, { repo: 'owner/repo', chatId: '1' });
    expect(first.coverUrl).toBeNull();
    const duplicate = await addSubscription(bindings, { repo: 'owner/repo', chatId: '2', coverUrl: '/covers/later.png' });
    expect(duplicate.coverUrl).toBe('/covers/later.png');
  });
  it('shares one cover across all subscriptions of the same project', async () => {
    const first = await addSubscription(bindings, { repo: 'owner/repo', chatId: '1' });
    const second = await addSubscription(bindings, { repo: 'owner/repo', chatId: '2' });
    await updateSubscription(bindings, first.id, { coverUrl: 'https://cdn.example.com/shared.png' });
    const covers = (await listSubscriptions(bindings)).map(row => row.coverUrl);
    expect(covers).toEqual(['https://cdn.example.com/shared.png', 'https://cdn.example.com/shared.png']);
    expect(second.projectId).toBe(first.projectId);
  });
});

describe('cover updates and removal through the API', () => {
  it('updates and clears the cover, rejecting invalid replacements without side effects', async () => {
    const created = await request('/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo' }) });
    const { subscription } = await created.json() as { subscription: { id: number; projectId: number } };
    const patched = await request('/api/subscriptions/' + subscription.id, { method: 'PATCH', headers, body: JSON.stringify({ coverUrl: 'https://cdn.example.com/new.png' }) });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ subscription: { coverUrl: 'https://cdn.example.com/new.png' } });
    const rejected = await request('/api/subscriptions/' + subscription.id, { method: 'PATCH', headers, body: JSON.stringify({ coverUrl: 'http://insecure.example.com/a.png' }) });
    expect(rejected.status).toBe(400);
    expect(await coverOf(subscription.projectId)).toBe('https://cdn.example.com/new.png');
    const cleared = await request('/api/subscriptions/' + subscription.id, { method: 'PATCH', headers, body: JSON.stringify({ coverUrl: null }) });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ subscription: { coverUrl: null } });
    expect(await coverOf(subscription.projectId)).toBeNull();
  });
  it('requires authentication for cover changes', async () => {
    const created = await request('/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo' }) });
    const { subscription } = await created.json() as { subscription: { id: number; projectId: number } };
    expect((await request('/api/subscriptions/' + subscription.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coverUrl: null }) })).status).toBe(401);
    expect(await coverOf(subscription.projectId)).toBeNull();
  });
});

describe('public cover exposure', () => {
  it('exposes only the cover of visible public projects', async () => {
    const visible = await addSubscription(bindings, { repo: 'owner/public', chatId: '12345', coverUrl: 'https://cdn.example.com/public.png' });
    await bindings.DB.prepare('UPDATE projects SET is_public=1,visibility_checked_at=? WHERE id=?').bind(timestamp, visible.projectId).run();
    const hidden = await addSubscription(bindings, { repo: 'owner/private', chatId: '12345', coverUrl: 'https://cdn.example.com/private.png' });
    await bindings.DB.prepare('UPDATE projects SET is_public=0,visibility_checked_at=? WHERE id=?').bind(timestamp, hidden.projectId).run();
    await bindings.DB.prepare(`INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token)
      VALUES(1,?, 'v1','Release 1','https://github.com/owner/public/releases/tag/v1','notes',0,?,?,?, 'fixture')`)
      .bind(visible.projectId, timestamp, timestamp, timestamp).run();
    const dashboard = await getPublicDashboard(bindings);
    expect(dashboard.subscriptions.map(row => row.coverUrl)).toEqual(['https://cdn.example.com/public.png']);
    expect(dashboard.releases.map(row => row.coverUrl)).toEqual(['https://cdn.example.com/public.png']);
    expect(JSON.stringify(dashboard)).not.toContain('private.png');
    const response = await request('/api/public/dashboard');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subscriptions: [{ coverUrl: 'https://cdn.example.com/public.png' }] });
  });
});
