import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import worker from '../src/server';
import type { Env } from '../src/server/env';
import { sendTelegramMessage, TelegramError } from '../src/server/telegram-client';
import { initializeTestSchema } from './schema';

const bindings = env as unknown as Env;
async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  return worker.fetch!(new Request('https://release-watch.example' + path, init), { ...bindings, ...overrides }, {} as ExecutionContext);
}
beforeAll(() => initializeTestSchema(bindings.DB));
beforeEach(async () => {
  await bindings.DB.batch(['subscription_release_skips', 'deliveries', 'releases', 'subscriptions', 'projects', 'settings', 'telegram_updates', 'chat_delivery_locks']
    .map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
});
afterEach(() => vi.restoreAllMocks());

describe('API access boundaries', () => {
  it('exposes the health and public dashboard endpoints without a token', async () => {
    expect(await (await request('/api/health')).json()).toEqual({ ok: true });
    const response = await request('/api/public/dashboard');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subscriptions: [], releases: [], status: { projectCount: 0 } });
    expect((await request('/api/dashboard')).status).toBe(401);
    expect((await request('/api/not-found')).status).toBe(401);
    expect((await request('/api/health', { method: 'POST' })).status).toBe(401);
  });
  it('fails closed if the admin secret is absent or too short', async () => {
    expect((await request('/api/dashboard', {}, { ADMIN_TOKEN: undefined })).status).toBe(503);
    expect((await request('/api/dashboard', {}, { ADMIN_TOKEN: 'short' })).status).toBe(503);
  });
  it.each([undefined, 'short'])('keeps public viewing available when the admin secret is %s', async secret => {
    expect((await request('/api/public/dashboard', {}, { ADMIN_TOKEN: secret })).status).toBe(200);
  });
  it.each([
    ['POST', '/api/subscriptions'], ['PATCH', '/api/subscriptions/1'], ['DELETE', '/api/subscriptions/1'],
    ['POST', '/api/projects/1/check'], ['POST', '/api/deliveries/retry'],
    ['POST', '/api/public/dashboard'], ['DELETE', '/api/public/dashboard'], ['GET', '/api/public/not-found'],
  ])('rejects anonymous and invalid-token requests to %s %s', async (method, path) => {
    const upstream = vi.spyOn(globalThis, 'fetch');
    expect((await request(path, { method })).status).toBe(401);
    expect((await request(path, { method, headers: { Authorization: 'Bearer invalid-token' } })).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS count FROM subscriptions').first()).toEqual({ count: 0 });
  });
  it('retains authenticated administrator create, update, and delete access', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 1, private: false }));
    const headers = { Authorization: 'Bearer ' + bindings.ADMIN_TOKEN, 'Content-Type': 'application/json' };
    const created = await request('/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo' }) });
    expect(created.status).toBe(201);
    const { subscription } = await created.json() as { subscription: { id: number } };
    const updated = await request('/api/subscriptions/' + subscription.id, { method: 'PATCH', headers, body: JSON.stringify({ paused: true, intervalMinutes: 30 }) });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ subscription: { paused: true, intervalMinutes: 30 } });
    expect((await request('/api/dashboard', { headers })).status).toBe(200);
    expect((await request('/api/subscriptions/' + subscription.id, { method: 'DELETE', headers })).status).toBe(200);
  });
  it('rejects malformed input before any database or upstream operation', async () => {
    const headers = { Authorization: 'Bearer ' + bindings.ADMIN_TOKEN, 'Content-Type': 'application/json' };
    const invalidRepo = await request('/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ repo: 42 }) });
    expect(invalidRepo.status).toBe(400);
    const badInterval = await request('/api/subscriptions', { method: 'POST', headers, body: JSON.stringify({ repo: 'owner/repo', intervalMinutes: 1 }) });
    expect(badInterval.status).toBe(400);
    const brokenJson = await request('/api/subscriptions', { method: 'POST', headers, body: '{' });
    expect(brokenJson.status).toBe(400);
    expect(brokenJson.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('/api/subscriptions', { method: 'POST', headers, body: 'x'.repeat(17000) })).status).toBe(413);
  });
  it('accepts JSON media type case variants and rejects misleading parameters', async () => {
    const headers = { Authorization: 'Bearer ' + bindings.ADMIN_TOKEN, 'Content-Type': 'Application/JSON; charset=UTF-8' };
    const validMediaType = await request('/api/subscriptions', { method: 'POST', headers, body: '{' });
    expect(validMediaType.status).toBe(400);
    const misleadingType = await request('/api/subscriptions', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain; note=application/json' }, body: '{}' });
    expect(misleadingType.status).toBe(415);
  });
});

describe('Telegram send transport', () => {
  it('uses a Workers-compatible request and never follows Telegram redirects with credentials', async () => {
    const outboundRequests: Request[] = [];
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      outboundRequests.push(new Request(input, init));
      return new Response(null, { status: 302, headers: { Location: 'https://example.com/untrusted' } });
    });
    await expect(sendTelegramMessage(bindings, '12345', 'hello')).rejects.toBeInstanceOf(TelegramError);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0].redirect).toBe('manual');
  });
  it('sends plain text without interpreting upstream release markup', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 23 } }), { status: 200 }));
    expect(await sendTelegramMessage(bindings, '12345', '<b>untrusted release</b>')).toBe(23);
    const init = upstream.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.text).toBe('<b>untrusted release</b>');
    expect(payload.parse_mode).toBeUndefined();
  });
  it.each([73, 172800])('honors retry_after=%s without leaking response text', async retryAfter => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false, description: 'secret-token', parameters: { retry_after: retryAfter } }), { status: 429 }));
    try { await sendTelegramMessage(bindings, '12345', 'hello'); expect.fail('expected rate limit'); }
    catch (error) { expect(error).toBeInstanceOf(TelegramError); expect((error as TelegramError).retryAfter).toBe(retryAfter); expect((error as Error).message).not.toContain('secret-token'); }
  });
  it('treats blocked recipients as permanent errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 403 }));
    await expect(sendTelegramMessage(bindings, '12345', 'hello')).rejects.toMatchObject({ permanent: true });
  });
});
