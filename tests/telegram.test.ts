import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { initializeTestSchema } from './schema';
import { handleTelegramWebhook } from '../src/server/telegram';
import type { Env } from '../src/server/env';
import { addSubscription, listSubscriptions } from '../src/server/subscriptions';
import { deliverPending } from '../src/server/deliveries';

const bindings = env as unknown as Env;
const webhookUrl = 'https://release-watch.example/telegram/webhook';
let upstream: MockInstance<typeof fetch>;

function update(text = '/help', updateId = 1) {
  return { update_id: updateId, message: { from: { id: 12345, is_bot: false }, chat: { id: 12345, type: 'private' }, text } };
}
function webhook(payload: unknown = update(), overrides: Partial<Env> = {}, headers: Record<string, string> = {}) {
  return handleTelegramWebhook(new Request(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': bindings.TELEGRAM_WEBHOOK_SECRET!, ...headers },
    body: JSON.stringify(payload),
  }), { ...bindings, ...overrides });
}
function messages(): Array<{ chat_id: string; text: string }> {
  return upstream.mock.calls.filter(([url]) => String(url).startsWith('https://api.telegram.org/'))
    .map(([, init]) => JSON.parse(init!.body as string));
}
async function expireChatCooldown() {
  await bindings.DB.prepare("UPDATE chat_delivery_locks SET next_send_at=0 WHERE chat_id='12345' AND lease_token IS NULL").run();
}

async function seedDelivery() {
  const subscription = await addSubscription(bindings, { repo: 'owner/repo', chatId: '12345' });
  const now = new Date().toISOString();
  await bindings.DB.batch([
    bindings.DB.prepare(`INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token)
      VALUES(1,?,'v1','Release v1','https://github.com/owner/repo/releases/tag/v1','',0,?,?,?,'fixture')`)
      .bind(subscription.projectId, now, now, now),
    bindings.DB.prepare("INSERT INTO deliveries(release_id,chat_id,created_at) VALUES(1,'12345',?)").bind(now),
  ]);
  upstream.mockClear();
}

beforeAll(() => initializeTestSchema(bindings.DB));
beforeEach(async () => {
  await bindings.DB.batch(['deliveries', 'releases', 'subscriptions', 'projects', 'settings', 'telegram_updates', 'chat_delivery_locks']
    .map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
  upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true, result: { message_id: 42 } }));
});
afterEach(() => vi.restoreAllMocks());

describe('Telegram webhook access boundaries', () => {
  it.each(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])('rejects %s before any authentication or processing', async method => {
    const result = await handleTelegramWebhook(new Request(webhookUrl, { method }), { ...bindings, TELEGRAM_WEBHOOK_SECRET: undefined });
    expect(result.status).toBe(405);
    expect(result.headers.get('Allow')).toBe('POST');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('fails closed for an unconfigured webhook secret (%s)', async secret => {
    expect((await webhook(update(), { TELEGRAM_WEBHOOK_SECRET: secret })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('checks the Telegram secret independently of the admin token', async () => {
    const result = await webhook(update(), {}, {
      Authorization: 'Bearer ' + bindings.ADMIN_TOKEN,
      'X-Telegram-Bot-Api-Secret-Token': bindings.ADMIN_TOKEN!,
    });
    expect(result.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect((await webhook(update(), { ADMIN_TOKEN: undefined })).status).toBe(200);
    expect(messages()).toHaveLength(1);
  });

  it.each(['', 'wrong-secret', 'test-webhook-secreu'])('rejects a missing or incorrect Telegram secret (%s)', async secret => {
    expect((await webhook(update(), {}, { 'X-Telegram-Bot-Api-Secret-Token': secret })).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT update_id FROM telegram_updates').first()).toBeNull();
  });

  it.each([undefined, '', '0', '-12345', '12345junk', '9007199254740992'])('fails closed for an invalid user whitelist (%s)', async allowed => {
    expect((await webhook(update(), { TELEGRAM_ALLOWED_USER_ID: allowed })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    { from: { id: 99999 }, chat: { id: 99999, type: 'private' } },
    { from: { id: '12345' }, chat: { id: 12345, type: 'private' } },
    { from: { id: 12345, is_bot: true }, chat: { id: 12345, type: 'private' } },
    { from: { id: 12345 }, chat: { id: -100, type: 'group' } },
    { from: { id: 12345 }, chat: { id: -100, type: 'supergroup' } },
    { from: { id: 12345 }, chat: { id: -100, type: 'channel' } },
    { from: { id: 12345 }, chat: { id: 99999, type: 'private' } },
    { from: { id: 12345 }, chat: { id: 12345, type: 'private' }, sender_chat: { id: 777 } },
  ])('ignores unauthorized or non-private messages without side effects: %j', async message => {
    expect((await webhook({ update_id: 1, message: { text: '/start', ...message } })).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT key FROM settings').first()).toBeNull();
    expect(await bindings.DB.prepare('SELECT update_id FROM telegram_updates').first()).toBeNull();
  });

  it.each([
    { update_id: 1 },
    { update_id: 1, message: null },
    { update_id: 1, message: [] },
    { update_id: 1, message: { chat: { id: 12345, type: 'private' }, text: '/start' } },
    { update_id: 1, edited_message: update('/start').message },
    { update_id: 1, callback_query: { from: { id: 12345 }, data: '/start' } },
    { update_id: 1, message: { ...update().message, text: { command: '/start' } } },
  ])('safely ignores unsupported message structures: %j', async payload => {
    expect((await webhook(payload)).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('reports a missing bot token without claiming or completing the update', async () => {
    const result = await webhook(update('/start'), { TELEGRAM_BOT_TOKEN: undefined });
    expect(result.status).toBe(503);
    expect(await result.text()).toContain('TELEGRAM_BOT_TOKEN');
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT update_id FROM telegram_updates').first()).toBeNull();
    expect((await webhook(update('/start'))).status).toBe(200);
  });
});

describe('Telegram webhook body validation', () => {
  it.each([null, [], {}, { update_id: '1' }, { update_id: -1 }, { update_id: 1.5 }, { update_id: 9007199254740992 }])('rejects an invalid update envelope: %j', async payload => {
    expect((await webhook(payload)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('accepts update_id zero', async () => {
    expect((await webhook(update('/help', 0))).status).toBe(200);
    expect(await bindings.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=0').first()).toEqual({ status: 'completed' });
  });

  it('rejects non-JSON content and malformed JSON', async () => {
    expect((await webhook(update(), {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
    const result = await handleTelegramWebhook(new Request(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': bindings.TELEGRAM_WEBHOOK_SECRET! }, body: '{',
    }), bindings);
    expect(result.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('enforces the body limit without relying on Content-Length', async () => {
    const payload = { ...update('/start'), padding: 'x'.repeat(65_536) };
    expect((await webhook(payload)).status).toBe(413);
    expect((await webhook(payload, {}, { 'Content-Length': '1' })).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT update_id FROM telegram_updates').first()).toBeNull();
  });

  it('counts bytes rather than characters and rejects oversized message text', async () => {
    expect((await webhook({ ...update(), padding: '汉'.repeat(23_000) })).status).toBe(413);
    expect((await webhook(update('x'.repeat(4097)))).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('Telegram commands through shared core interfaces', () => {
  it('binds /start and unbound subscriptions without moving another chat', async () => {
    await addSubscription({ ...bindings, TELEGRAM_CHAT_ID: undefined }, { repo: 'owner/unbound' });
    await addSubscription(bindings, { repo: 'owner/elsewhere', chatId: '99999' });
    upstream.mockClear();
    expect((await webhook(update('/start'))).status).toBe(200);
    expect(await bindings.DB.prepare("SELECT value FROM settings WHERE key='default_chat_id'").first()).toEqual({ value: '12345' });
    const subscriptions = await listSubscriptions(bindings);
    expect(subscriptions.find(item => item.repo === 'owner/unbound')?.chatId).toBe('12345');
    expect(subscriptions.find(item => item.repo === 'owner/elsewhere')?.chatId).toBe('99999');
    expect(messages()[0]).toMatchObject({ chat_id: '12345', text: expect.stringContaining('已将当前私聊绑定') });
    expect(messages()[0].text).toContain('/sub owner/repo');
  });

  it.each([['/sub Owner/Repo', false], ['/sub Owner/Repo --pre', true]])('adds a chat-scoped subscription for %s', async (text, prerelease) => {
    expect((await webhook(update(text))).status).toBe(200);
    expect(await listSubscriptions(bindings, '12345')).toMatchObject([{ repo: 'owner/repo', includePrerelease: prerelease, chatId: '12345' }]);
    expect(messages()[0].text).toContain('已订阅 owner/repo');
    const githubCall = upstream.mock.calls.find(([url]) => String(url).startsWith('https://api.github.com/'));
    expect(githubCall?.[0]).toBe('https://api.github.com/repos/owner/repo');
  });

  it.each(['/sub', '/sub owner/repo --bad', '/sub owner/repo --pre extra', '/sub https://evil.example/repo', '/sub owner/..', '/unsub', '/unsub owner/repo extra'])('returns useful usage for %s without adding a subscription', async text => {
    expect((await webhook(update(text))).status).toBe(200);
    expect(messages()[0].text).toContain('用法：');
    expect(await listSubscriptions(bindings)).toEqual([]);
    expect(upstream.mock.calls.every(([url]) => String(url).startsWith('https://api.telegram.org/'))).toBe(true);
  });

  it('removes only the current chat subscription for /unsub', async () => {
    await addSubscription(bindings, { repo: 'owner/repo', chatId: '12345' });
    await addSubscription(bindings, { repo: 'owner/repo', chatId: '99999' });
    upstream.mockClear();
    expect((await webhook(update('/unsub OWNER/REPO'))).status).toBe(200);
    expect(await listSubscriptions(bindings, '12345')).toEqual([]);
    expect(await listSubscriptions(bindings, '99999')).toHaveLength(1);
    expect(messages()[0].text).toContain('已取消当前私聊');
  });

  it('explains when the current chat is not subscribed', async () => {
    expect((await webhook(update('/unsub owner/repo'))).status).toBe(200);
    expect(messages()[0].text).toContain('尚未订阅');
  });

  it('lists only current chat subscriptions including prerelease and pause state', async () => {
    await addSubscription(bindings, { repo: 'owner/current', chatId: '12345', includePrerelease: true });
    await addSubscription(bindings, { repo: 'owner/other-chat', chatId: '99999' });
    await bindings.DB.prepare("UPDATE subscriptions SET paused=1 WHERE chat_id='12345'").run();
    upstream.mockClear();
    expect((await webhook(update('/list'))).status).toBe(200);
    expect(messages()[0].text).toContain('owner/current');
    expect(messages()[0].text).toContain('含预发布');
    expect(messages()[0].text).toContain('已暂停');
    expect(messages()[0].text).not.toContain('owner/other-chat');
  });

  it('provides an actionable empty list', async () => {
    expect((await webhook(update('/list'))).status).toBe(200);
    expect(messages()[0].text).toContain('/sub owner/repo');
  });

  it('reports missing GitHub configuration without disclosing any credentials', async () => {
    expect((await webhook(update('/status'), { GITHUB_TOKEN: undefined, ADMIN_TOKEN: 'private-admin-value' })).status).toBe(200);
    const text = messages()[0].text;
    expect(text).toContain('未配置，请设置 GITHUB_TOKEN');
    expect(text).toContain('最近定时检查');
    expect(text).not.toContain('private-admin-value');
    expect(text).not.toContain(bindings.TELEGRAM_BOT_TOKEN!);
    expect(text).not.toContain(bindings.TELEGRAM_WEBHOOK_SECRET!);
  });

  it.each(['/help', '/help@release_watch_bot', '/HELP'])('documents all commands for %s', async text => {
    expect((await webhook(update(text))).status).toBe(200);
    for (const command of ['/start', '/sub', '/unsub', '/list', '/status', '/help']) expect(messages()[0].text).toContain(command);
  });

  it.each(['/unknown', 'hello', ''])('provides help for an unknown command: %s', async text => {
    expect((await webhook(update(text))).status).toBe(200);
    expect(messages()[0].text).toContain('未识别的命令');
    expect(messages()[0].text).toContain('/help');
  });

  it('limits long lists to one reply and directs users to the complete web list', async () => {
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 70; i++) {
      const repo = `${'o'.repeat(39)}/${String(i).padStart(2, '0')}${'x'.repeat(98)}`;
      statements.push(bindings.DB.prepare('INSERT INTO projects(repo,created_at,next_check_at) VALUES(?,?,?)').bind(repo, now, now));
      statements.push(bindings.DB.prepare('INSERT INTO subscriptions(project_id,chat_id,created_at,notify_after) SELECT id,?,?,? FROM projects WHERE repo=?').bind('12345', now, now, repo));
    }
    await bindings.DB.batch(statements);
    expect((await webhook(update('/list'))).status).toBe(200);
    expect(messages()).toHaveLength(1);
    expect(messages()[0].text.length).toBeLessThanOrEqual(4000);
    expect(messages()[0].text).toContain('另有 50 个订阅');
    expect(messages()[0].text).toContain('网页查看完整列表');
    expect(messages()[0].text).toContain('/69');
  });
});

describe('Telegram update deduplication and recoverable processing leases', () => {
  it('acknowledges a completed duplicate without sending or executing it again', async () => {
    expect((await webhook(update('/sub owner/repo', 42))).status).toBe(200);
    const calls = upstream.mock.calls.length;
    expect((await webhook(update('/sub owner/repo', 42))).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(calls);
    expect(await listSubscriptions(bindings, '12345')).toHaveLength(1);
    expect(await bindings.DB.prepare('SELECT status,lease_token,lease_until FROM telegram_updates WHERE update_id=42').first()).toEqual({ status: 'completed', lease_token: null, lease_until: 0 });
  });

  it('processes distinct updates even if they arrive out of order', async () => {
    expect((await webhook(update('/help', 42))).status).toBe(200);
    await expireChatCooldown();
    expect((await webhook(update('/help', 7))).status).toBe(200);
    expect(messages()).toHaveLength(2);
  });

  it('returns a retryable response for an active lease without side effects', async () => {
    await bindings.DB.prepare("INSERT INTO telegram_updates(update_id,status,lease_token,lease_until,updated_at) VALUES(1,'processing','active',?,?)").bind(Date.now() + 60_000, Date.now()).run();
    const result = await webhook(update('/start'));
    expect(result.status).toBe(503);
    expect(result.headers.get('Retry-After')).toBe('5');
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT key FROM settings').first()).toBeNull();
  });

  it('recovers an expired lease left by a terminated request', async () => {
    await bindings.DB.prepare("INSERT INTO telegram_updates(update_id,status,lease_token,lease_until,updated_at) VALUES(1,'processing','abandoned',?,?)").bind(Date.now() - 1, Date.now() - 120_001).run();
    expect((await webhook()).status).toBe(200);
    expect(messages()).toHaveLength(1);
    expect(await bindings.DB.prepare('SELECT status,lease_token FROM telegram_updates WHERE update_id=1').first()).toEqual({ status: 'completed', lease_token: null });
  });

  it('keeps the lease processing until Telegram accepts the reply and blocks concurrent delivery', async () => {
    let releaseSend!: () => void;
    let reachedSend!: () => void;
    const gate = new Promise<void>(resolve => { releaseSend = resolve; });
    const reached = new Promise<void>(resolve => { reachedSend = resolve; });
    upstream.mockImplementation(async () => {
      reachedSend();
      await gate;
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    const first = webhook();
    await reached;
    try {
      expect(await bindings.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=1').first()).toEqual({ status: 'processing' });
      expect((await webhook()).status).toBe(503);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { releaseSend(); }
    expect((await first).status).toBe(200);
    expect(await bindings.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=1').first()).toEqual({ status: 'completed' });
  });

  it('defers a failed network send for at least 60 seconds and retries without duplicating the subscription', async () => {
    upstream.mockImplementation(async url => {
      if (String(url).startsWith('https://api.telegram.org/')) throw new Error('upstream-token-must-stay-secret');
      return Response.json({});
    });
    const startedAt = Date.now();
    const failed = await webhook(update('/sub owner/repo'));
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('60');
    expect(await failed.text()).not.toContain('upstream-token-must-stay-secret');
    const deferred = await bindings.DB.prepare('SELECT status,lease_token,lease_until FROM telegram_updates WHERE update_id=1')
      .first<{ status: string; lease_token: string | null; lease_until: number }>();
    expect(deferred).toMatchObject({ status: 'processing', lease_token: null });
    expect(deferred!.lease_until).toBeGreaterThanOrEqual(startedAt + 60_000);
    const chat = await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'")
      .first<{ next_send_at: number; lease_token: string | null; lease_until: number }>();
    expect(chat).toMatchObject({ lease_token: null, lease_until: 0 });
    expect(chat!.next_send_at).toBeGreaterThanOrEqual(startedAt + 60_000);
    const calls = upstream.mock.calls.length;
    expect((await webhook(update('/sub owner/repo'))).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(calls);
    await bindings.DB.prepare('UPDATE telegram_updates SET lease_until=0 WHERE update_id=1').run();
    await expireChatCooldown();
    upstream.mockResolvedValue(Response.json({ ok: true, result: { message_id: 43 } }));
    expect((await webhook(update('/sub owner/repo'))).status).toBe(200);
    expect(await listSubscriptions(bindings, '12345')).toHaveLength(1);
    expect(await bindings.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=1').first()).toEqual({ status: 'completed' });
  });

  it.each([401, 429, 502])('gives a safe Chinese explanation and remains retryable after GitHub HTTP %s', async status => {
    upstream.mockImplementation(async url => String(url).startsWith('https://api.github.com/')
      ? Response.json({ message: 'github-credential-must-stay-secret' }, { status })
      : Response.json({ ok: true, result: { message_id: 42 } }));
    const failed = await webhook(update('/sub owner/repo'));
    expect(failed.status).toBe(503);
    expect(messages()[0].text).toContain('GitHub');
    expect(messages()[0].text).toContain('重试');
    expect(messages()[0].text).not.toContain('github-credential-must-stay-secret');
    const deferred = await bindings.DB.prepare('SELECT status,lease_until FROM telegram_updates WHERE update_id=1').first<{ status: string; lease_until: number }>();
    expect(deferred?.status).toBe('processing');
    expect(deferred!.lease_until).toBeGreaterThan(Date.now());
    expect(failed.headers.get('Retry-After')).toBe('60');
    expect((await webhook(update('/sub owner/repo'))).status).toBe(503);
    expect(messages()).toHaveLength(1);
    await bindings.DB.prepare('UPDATE telegram_updates SET lease_until=0 WHERE update_id=1').run();
    upstream.mockImplementation(async () => Response.json({ ok: true, result: { message_id: 43 } }));
    await expireChatCooldown();
    expect((await webhook(update('/sub owner/repo'))).status).toBe(200);
    expect(await listSubscriptions(bindings, '12345')).toHaveLength(1);
  });

  it('acknowledges a missing repository only after sending actionable feedback', async () => {
    upstream.mockImplementation(async url => String(url).startsWith('https://api.github.com/')
      ? Response.json({ message: 'private-upstream-detail' }, { status: 404 })
      : Response.json({ ok: true, result: { message_id: 42 } }));
    expect((await webhook(update('/sub owner/missing'))).status).toBe(200);
    expect(messages()[0].text).toContain('找不到该 GitHub 仓库');
    expect(messages()[0].text).toContain('GITHUB_TOKEN');
    expect(messages()[0].text).not.toContain('private-upstream-detail');
    expect(await bindings.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=1').first()).toEqual({ status: 'completed' });
  });

  it('cannot complete or release a lease acquired by another owner', async () => {
    upstream.mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE telegram_updates SET lease_token='new-owner',lease_until=? WHERE update_id=1").bind(Date.now() + 120_000).run();
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    expect((await webhook()).status).toBe(503);
    expect(await bindings.DB.prepare('SELECT status,lease_token FROM telegram_updates WHERE update_id=1').first()).toEqual({ status: 'processing', lease_token: 'new-owner' });
  });
});

describe('Telegram webhook shared chat locks and retry deadlines', () => {
  it.each(['lease', 'cooldown'])('does not send while a chat %s is active and recovers after expiry', async kind => {
    const now = Date.now();
    const held = {
      next_send_at: kind === 'cooldown' ? now + 120_000 : 0,
      lease_token: kind === 'lease' ? 'cron-owner' : null,
      lease_until: kind === 'lease' ? now + 30_000 : 0,
    };
    await bindings.DB.prepare('INSERT INTO chat_delivery_locks(chat_id,next_send_at,lease_token,lease_until) VALUES(?,?,?,?)')
      .bind('12345', held.next_send_at, held.lease_token, held.lease_until).run();
    expect((await webhook()).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT status,lease_token,lease_until FROM telegram_updates WHERE update_id=1').first())
      .toEqual({ status: 'processing', lease_token: null, lease_until: 0 });
    expect(await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'").first())
      .toEqual(held);
    await bindings.DB.prepare("UPDATE chat_delivery_locks SET next_send_at=0,lease_until=0 WHERE chat_id='12345'").run();
    const resumedAt = Date.now();
    expect((await webhook()).status).toBe(200);
    expect(messages()).toHaveLength(1);
    const released = await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'")
      .first<{ next_send_at: number; lease_token: string | null; lease_until: number }>();
    expect(released).toMatchObject({ lease_token: null, lease_until: 0 });
    expect(released!.next_send_at).toBeGreaterThanOrEqual(resumedAt + 1000);
  });

  it('persists Telegram Retry-After for both the chat and update and resumes only after their deadlines', async () => {
    upstream.mockResolvedValue(Response.json({ ok: false, parameters: { retry_after: 120 } }, { status: 429 }));
    const startedAt = Date.now();
    const failed = await webhook();
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('120');
    const deferred = await bindings.DB.prepare('SELECT status,lease_token,lease_until FROM telegram_updates WHERE update_id=1')
      .first<{ status: string; lease_token: string | null; lease_until: number }>();
    const chat = await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'")
      .first<{ next_send_at: number; lease_token: string | null; lease_until: number }>();
    expect(deferred).toMatchObject({ status: 'processing', lease_token: null });
    expect(deferred!.lease_until).toBeGreaterThanOrEqual(startedAt + 120_000);
    expect(chat).toMatchObject({ lease_token: null, lease_until: 0 });
    expect(chat!.next_send_at).toBeGreaterThanOrEqual(deferred!.lease_until);
    expect((await webhook()).status).toBe(503);
    expect(messages()).toHaveLength(1);
    expect(await bindings.DB.prepare('SELECT status,lease_token,lease_until FROM telegram_updates WHERE update_id=1').first()).toEqual(deferred);
    expect(await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'").first()).toEqual(chat);

    // The update must remain deferred even if another sender clears the chat cooldown.
    await expireChatCooldown();
    expect((await webhook()).status).toBe(503);
    expect(messages()).toHaveLength(1);
    await bindings.DB.prepare("UPDATE chat_delivery_locks SET next_send_at=? WHERE chat_id='12345'").bind(chat!.next_send_at).run();
    await bindings.DB.prepare('UPDATE telegram_updates SET lease_until=0 WHERE update_id=1').run();
    // Conversely, an eligible update must still respect the chat's Retry-After.
    expect((await webhook()).status).toBe(503);
    expect(messages()).toHaveLength(1);
    expect(await bindings.DB.prepare("SELECT next_send_at FROM chat_delivery_locks WHERE chat_id='12345'").first())
      .toEqual({ next_send_at: chat!.next_send_at });
    await expireChatCooldown();
    upstream.mockResolvedValue(Response.json({ ok: true, result: { message_id: 43 } }));
    expect((await webhook()).status).toBe(200);
    expect((await webhook()).status).toBe(200);
    expect(messages()).toHaveLength(2);
    expect(await bindings.DB.prepare('SELECT status,lease_token,lease_until FROM telegram_updates WHERE update_id=1').first())
      .toEqual({ status: 'completed', lease_token: null, lease_until: 0 });
  });

  it.each(['webhook', 'cron'])('excludes both cron and distinct updates while %s owns the chat', async sender => {
    await seedDelivery();
    let releaseSend!: () => void;
    let reachedSend!: () => void;
    const gate = new Promise<void>(resolve => { releaseSend = resolve; });
    const reached = new Promise<void>(resolve => { reachedSend = resolve; });
    upstream.mockImplementation(async () => {
      reachedSend();
      await gate;
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    const first = sender === 'webhook' ? webhook().then(result => result.status) : deliverPending(bindings).then(result => result.sent);
    await reached;
    const finishedAfter = Date.now();
    try {
      const held = await bindings.DB.prepare("SELECT lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'")
        .first<{ lease_token: string; lease_until: number }>();
      expect(held!.lease_token).toEqual(expect.any(String));
      expect(held!.lease_until).toBeGreaterThan(Date.now());
      expect((await webhook(update('/help', 2))).status).toBe(503);
      expect(await deliverPending(bindings)).toEqual({ sent: 0, failed: 0 });
      expect(messages()).toHaveLength(1);
      expect(await bindings.DB.prepare("SELECT lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'").first()).toEqual(held);
    } finally { releaseSend(); }
    expect(await first).toBe(sender === 'webhook' ? 200 : 1);
    const released = await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'")
      .first<{ next_send_at: number; lease_token: string | null; lease_until: number }>();
    expect(released).toMatchObject({ lease_token: null, lease_until: 0 });
    expect(released!.next_send_at).toBeGreaterThanOrEqual(finishedAfter + 1000);
    await expireChatCooldown();
    if (sender === 'webhook') expect(await deliverPending(bindings)).toEqual({ sent: 1, failed: 0 });
    else expect((await webhook(update('/help', 2))).status).toBe(200);
    expect(messages()).toHaveLength(2);
  });

  it.each([false, true])('does not release or shorten a replacement chat owner after send failure=%s', async fail => {
    const replacement = { next_send_at: Date.now() + 300_000, lease_token: 'new-chat-owner', lease_until: Date.now() + 120_000 };
    upstream.mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE chat_delivery_locks SET next_send_at=?,lease_token=?,lease_until=? WHERE chat_id='12345'")
        .bind(replacement.next_send_at, replacement.lease_token, replacement.lease_until).run();
      if (fail) throw new Error('Temporary network failure');
      return Response.json({ ok: true, result: { message_id: 42 } });
    });
    expect((await webhook()).status).toBe(fail ? 503 : 200);
    expect(await bindings.DB.prepare("SELECT next_send_at,lease_token,lease_until FROM chat_delivery_locks WHERE chat_id='12345'").first())
      .toEqual(replacement);
  });
});
