import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Env } from '../src/server/env';
import { deliverPending } from '../src/server/deliveries';
import { addSubscription, bindDefaultChat, removeSubscription, updateSubscription } from '../src/server/subscriptions';
import { enqueueGroupReleases, RELEASE_GROUP_SETTING, RELEASE_GROUP_SINCE_SETTING } from '../src/server/release-targets';
import { setting } from '../src/server/db';
import { initializeTestSchema } from './schema';

const bindings = env as unknown as Env;
const runtime: Env = { ...bindings, DEEPSEEK_API_KEY: undefined };
const GROUP = '-1001234567890';
const OTHER_GROUP = '-1009876543210';
const BASE = Date.parse('2026-10-19T12:00:00.000Z');
const CREATED = new Date(BASE - 86_400_000).toISOString();
const RELEASED = new Date(BASE + 1000).toISOString();

async function seedSubscription(chatId = '12345', options: { prerelease?: boolean; paused?: boolean; notifyAfter?: string } = {}): Promise<number> {
  const result = await bindings.DB.prepare(`INSERT INTO subscriptions(project_id,chat_id,include_prerelease,paused,created_at,notify_after)
    VALUES(1,?,?,?,?,?) RETURNING id`).bind(chatId, Number(options.prerelease ?? false), Number(options.paused ?? false), CREATED, options.notifyAfter ?? CREATED).first<{ id: number }>();
  return result!.id;
}
async function seedRelease(id = 1, options: { prerelease?: boolean; notifyAt?: string; body?: string } = {}): Promise<void> {
  await bindings.DB.prepare(`INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token)
    VALUES(?,1,?,?,?,?,?,?,?,?,?)`).bind(id, `v${id}`, `Version ${id}`, `https://github.com/owner/repo/releases/tag/v${id}`,
    options.body ?? '', Number(options.prerelease ?? false), RELEASED, RELEASED, options.notifyAt ?? RELEASED, 'group-test').run();
}
async function seedDirectDelivery(chatId = '12345', releaseId = 1): Promise<void> {
  await bindings.DB.prepare('INSERT INTO deliveries(release_id,chat_id,created_at) VALUES(?,?,?)').bind(releaseId, chatId, RELEASED).run();
}

beforeAll(() => initializeTestSchema(bindings.DB));
beforeEach(async () => {
  await bindings.DB.batch(['deliveries', 'subscription_release_skips', 'releases', 'subscriptions', 'projects', 'settings', 'chat_delivery_locks']
    .map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
  await bindings.DB.prepare("INSERT INTO projects(id,repo,created_at,next_check_at,initialized,is_public) VALUES(1,'owner/repo',?,?,1,1)").bind(CREATED, CREATED).run();
  vi.spyOn(Date, 'now').mockReturnValue(BASE);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 42 } }));
});
afterEach(() => vi.restoreAllMocks());

describe('release group binding', () => {
  it('binds group mirroring without replacing the private subscription', async () => {
    const id = await seedSubscription();
    await bindDefaultChat(runtime, GROUP);
    expect(await setting(runtime, RELEASE_GROUP_SETTING)).toBe(GROUP);
    expect(await setting(runtime, RELEASE_GROUP_SINCE_SETTING)).toBe(new Date(BASE).toISOString());
    expect(await bindings.DB.prepare('SELECT id,chat_id FROM subscriptions').first()).toEqual({ id, chat_id: '12345' });
  });
  it('keeps the baseline on a repeated binding and keeps mirroring after a private /start', async () => {
    await bindDefaultChat(runtime, GROUP);
    vi.mocked(Date.now).mockReturnValue(BASE + 60_000);
    await bindDefaultChat(runtime, GROUP);
    await bindDefaultChat(runtime, '12345');
    expect(await setting(runtime, RELEASE_GROUP_SETTING)).toBe(GROUP);
    expect(await setting(runtime, RELEASE_GROUP_SINCE_SETTING)).toBe(new Date(BASE).toISOString());
    expect(await setting(runtime, 'default_chat_id')).toBe('12345');
  });
  it('moves the group and notification baseline when binding a different group', async () => {
    await bindDefaultChat(runtime, GROUP);
    vi.mocked(Date.now).mockReturnValue(BASE + 60_000);
    await bindDefaultChat(runtime, OTHER_GROUP);
    expect(await setting(runtime, RELEASE_GROUP_SETTING)).toBe(OTHER_GROUP);
    expect(await setting(runtime, RELEASE_GROUP_SINCE_SETTING)).toBe(new Date(BASE + 60_000).toISOString());
  });
});

describe('release group fanout and eligibility', () => {
  it('sends new versions once to the private chat and once to the group without a duplicate subscription', async () => {
    await seedSubscription(); await bindDefaultChat(runtime, GROUP); await seedRelease(); await seedDirectDelivery();
    expect(await deliverPending(runtime)).toEqual({ sent: 1, failed: 0 });
    expect(await deliverPending(runtime)).toEqual({ sent: 1, failed: 0 });
    expect(await deliverPending(runtime)).toEqual({ sent: 0, failed: 0 });
    const messages = vi.mocked(fetch).mock.calls.map(([, init]) => z.object({ chat_id: z.string(), text: z.string() }).parse(JSON.parse(String(init?.body))));
    expect(messages.map(message => message.chat_id)).toEqual(['12345', GROUP]);
    expect(messages[0].text).toBe(messages[1].text);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions').first()).toEqual({ count: 1 });
  });
  it('deduplicates the group copy across subscribers and direct group subscriptions', async () => {
    await seedSubscription(); await seedSubscription('99999'); await seedSubscription(GROUP);
    await bindDefaultChat(runtime, GROUP); await seedRelease(); await seedDirectDelivery(GROUP);
    await Promise.all([enqueueGroupReleases(runtime, RELEASED), enqueueGroupReleases(runtime, RELEASED)]);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS count FROM deliveries WHERE chat_id=?').bind(GROUP).first()).toEqual({ count: 1 });
  });
  it('mirrors a newly added private subscription automatically', async () => {
    await bindDefaultChat(runtime, GROUP);
    await addSubscription(runtime, { repo: 'owner/repo', chatId: '12345' });
    await seedRelease(); await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT chat_id FROM deliveries').first()).toEqual({ chat_id: GROUP });
  });
  it('does not backfill releases from before group binding', async () => {
    await seedSubscription(); await seedRelease(1, { notifyAt: CREATED }); await bindDefaultChat(runtime, GROUP);
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
  });
  it('requires an active source and at least one eligible prerelease subscription', async () => {
    const id = await seedSubscription('12345', { paused: true });
    await bindDefaultChat(runtime, GROUP); await seedRelease(1, { prerelease: true });
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
    await updateSubscription(runtime, id, { paused: false });
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
    await updateSubscription(runtime, id, { includePrerelease: true });
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT chat_id FROM deliveries').first()).toEqual({ chat_id: GROUP });
  });
  it('respects resume baselines and skipped promotions', async () => {
    const id = await seedSubscription('12345', { notifyAfter: new Date(BASE + 2000).toISOString() });
    await bindDefaultChat(runtime, GROUP); await seedRelease();
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
    await bindings.DB.prepare('UPDATE subscriptions SET notify_after=? WHERE id=?').bind(CREATED, id).run();
    await bindings.DB.prepare('INSERT INTO subscription_release_skips(subscription_id,release_id) VALUES(?,1)').bind(id).run();
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
  });
  it('cancels an unsent group copy when its only source is paused', async () => {
    const id = await seedSubscription(); await bindDefaultChat(runtime, GROUP); await seedRelease();
    await enqueueGroupReleases(runtime, RELEASED);
    await updateSubscription(runtime, id, { paused: true });
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
    await deliverPending(runtime);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps the group copy if another subscription remains eligible after pausing the direct group subscription', async () => {
    await seedSubscription(); const groupId = await seedSubscription(GROUP);
    await bindDefaultChat(runtime, GROUP); await seedRelease(); await enqueueGroupReleases(runtime, RELEASED);
    await updateSubscription(runtime, groupId, { paused: true });
    expect(await bindings.DB.prepare('SELECT chat_id FROM deliveries').first()).toEqual({ chat_id: GROUP });
    expect(await deliverPending(runtime)).toEqual({ sent: 1, failed: 0 });
  });
  it('retains a shared group delivery when removing one source, then removes it with the last source', async () => {
    const id = await seedSubscription(); const other = await seedSubscription('99999');
    await bindDefaultChat(runtime, GROUP); await seedRelease(); await enqueueGroupReleases(runtime, RELEASED);
    await removeSubscription(runtime, id);
    expect(await bindings.DB.prepare('SELECT chat_id FROM deliveries').first()).toEqual({ chat_id: GROUP });
    await removeSubscription(runtime, other);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
  });
  it('rejects a malformed target stored as a group setting', async () => {
    await seedSubscription(); await bindDefaultChat(runtime, GROUP); await seedRelease();
    await bindings.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind('-100bad', RELEASE_GROUP_SETTING).run();
    await enqueueGroupReleases(runtime, RELEASED);
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
  });
});

describe('release group recovery', () => {
  it('retries a failed group delivery independently from a completed private delivery', async () => {
    await seedSubscription(); await bindDefaultChat(runtime, GROUP); await seedRelease(); await seedDirectDelivery();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 1 } }))
      .mockResolvedValueOnce(Response.json({ ok: false, parameters: { retry_after: 120 } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 2 } }));
    await deliverPending(runtime);
    expect(await deliverPending(runtime)).toEqual({ sent: 0, failed: 1 });
    expect(await bindings.DB.prepare("SELECT status FROM deliveries WHERE chat_id='12345'").first()).toEqual({ status: 'sent' });
    expect(await bindings.DB.prepare('SELECT status,attempts FROM deliveries WHERE chat_id=?').bind(GROUP).first()).toEqual({ status: 'pending', attempts: 1 });
    vi.mocked(Date.now).mockReturnValue(BASE + 120_000);
    expect(await deliverPending(runtime)).toEqual({ sent: 1, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('drops an unsent copy for a replaced group instead of sending old queued versions to the new group', async () => {
    await seedSubscription(); await bindDefaultChat(runtime, GROUP); await seedRelease(); await enqueueGroupReleases(runtime, RELEASED);
    vi.mocked(Date.now).mockReturnValue(BASE + 60_000);
    await bindDefaultChat(runtime, OTHER_GROUP);
    await deliverPending(runtime);
    expect(fetch).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
  });
  it('rechecks source eligibility after optional summary processing and before Telegram sends', async () => {
    const id = await seedSubscription(); await bindDefaultChat(runtime, GROUP); await seedRelease(1, { body: 'Release notes' });
    await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('deepseek_api_key','sk-test-key-0123456789abcdef')").run();
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await updateSubscription(runtime, id, { paused: true });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '版本摘要' } }] });
    });
    expect(await deliverPending(runtime)).toEqual({ sent: 0, failed: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
  });
});

it('migrates an existing default group into mirroring without moving private subscriptions or backfilling old releases', async () => {
  await seedSubscription(); await seedRelease(1, { notifyAt: CREATED });
  await bindings.DB.prepare("INSERT INTO settings(key,value) VALUES('default_chat_id',?)").bind(GROUP).run();
  await initializeTestSchema(bindings.DB);
  expect(await setting(runtime, RELEASE_GROUP_SETTING)).toBe(GROUP);
  expect(await setting(runtime, RELEASE_GROUP_SINCE_SETTING)).toBeTruthy();
  expect(await bindings.DB.prepare('SELECT chat_id FROM subscriptions').first()).toEqual({ chat_id: '12345' });
  await enqueueGroupReleases(runtime, RELEASED);
  expect(await bindings.DB.prepare('SELECT id FROM deliveries').first()).toBeNull();
});
