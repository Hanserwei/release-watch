import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/server';
import type { Env } from '../src/server/env';
import { getDeepSeekApiKey, getDeepSeekSettings } from '../src/server/settings';
import { initializeTestSchema } from './schema';

const bindings = env as unknown as Env;
const ADMIN = 'Bearer ' + bindings.ADMIN_TOKEN;
const JSON_HEADERS = { Authorization: ADMIN, 'Content-Type': 'application/json' };
const validKey = 'sk-deepseek-test-key-0123456789';
const envKey = 'sk-environment-key-abcdefghijklmn';

async function request(path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  return worker.fetch!(new Request('https://release-watch.example' + path, init), { ...bindings, DEEPSEEK_API_KEY: undefined, ...overrides }, {} as ExecutionContext);
}
async function patch(body: unknown, overrides: Partial<Env> = {}) {
  return request('/api/settings/deepseek', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) }, overrides);
}
async function settings(overrides: Partial<Env> = {}) {
  const response = await request('/api/settings/deepseek', { headers: { Authorization: ADMIN } }, overrides);
  expect(response.status).toBe(200);
  return await response.json() as { deepseek: unknown };
}
async function storedKeys(): Promise<string[]> {
  const { results } = await bindings.DB.prepare('SELECT key FROM settings ORDER BY key').all<{ key: string }>();
  return results.map(row => row.key);
}

beforeAll(async () => { await initializeTestSchema(bindings.DB); });
beforeEach(async () => {
  await bindings.DB.batch(['settings', 'deliveries', 'releases', 'subscriptions', 'projects', 'subscription_release_skips', 'telegram_updates', 'chat_delivery_locks']
    .map(table => bindings.DB.prepare(`DELETE FROM ${table}`)));
});
afterEach(() => vi.restoreAllMocks());

describe('DeepSeek settings access control', () => {
  it('rejects anonymous and invalid-token requests', async () => {
    const body = JSON.stringify({ apiKey: validKey });
    expect((await request('/api/settings/deepseek')).status).toBe(401);
    expect((await request('/api/settings/deepseek', { headers: { Authorization: 'Bearer wrong-token-value-that-is-long' } })).status).toBe(401);
    expect((await request('/api/settings/deepseek', { method: 'PATCH', body })).status).toBe(401);
    expect((await request('/api/settings/deepseek', { method: 'PATCH', headers: { Authorization: 'Bearer wrong-token-value-that-is-long', 'Content-Type': 'application/json' }, body })).status).toBe(401);
    expect(await storedKeys()).toEqual([]);
  });
  it('fails closed when the administrator secret is not configured', async () => {
    expect((await request('/api/settings/deepseek', { headers: { Authorization: ADMIN } }, { ADMIN_TOKEN: undefined })).status).toBe(503);
    expect(await storedKeys()).toEqual([]);
  });
  it('rejects non-JSON bodies and oversized payloads before writing', async () => {
    expect((await request('/api/settings/deepseek', { method: 'PATCH', headers: { Authorization: ADMIN, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await request('/api/settings/deepseek', { method: 'PATCH', headers: JSON_HEADERS, body: '{' })).status).toBe(400);
    expect((await request('/api/settings/deepseek', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ apiKey: 'x'.repeat(17_000) }) })).status).toBe(413);
    expect(await storedKeys()).toEqual([]);
  });
});

describe('DeepSeek settings configuration lifecycle', () => {
  it('reports an unconfigured service without inventing defaults', async () => {
    expect((await settings()).deepseek).toEqual({ configured: false, enabled: false, model: 'deepseek-chat', source: null });
  });
  it('stores a key and returns only boolean status plus the model name', async () => {
    const response = await patch({ apiKey: validKey });
    expect(response.status).toBe(200);
    const body = await response.json() as { deepseek: Record<string, unknown> };
    expect(body.deepseek).toEqual({ configured: true, enabled: true, model: 'deepseek-chat', source: 'database' });
    expect(JSON.stringify(body)).not.toContain(validKey);
    expect(Object.keys(body.deepseek).sort()).toEqual(['configured', 'enabled', 'model', 'source']);
    expect(await bindings.DB.prepare("SELECT value FROM settings WHERE key='deepseek_api_key'").first()).toEqual({ value: validKey });
    expect(await getDeepSeekApiKey(bindings)).toBe(validKey);
  });
  it('trims surrounding whitespace and never echoes the secret in errors or logs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await patch({ apiKey: `  ${validKey}  ` })).status).toBe(200);
    const tooShort = await patch({ apiKey: 'sk-short' });
    expect(tooShort.status).toBe(400);
    const control = await patch({ apiKey: 'sk-control-char-key-0123456789\u0007' });
    expect(control.status).toBe(400);
    const spaced = await patch({ apiKey: 'sk-key with spaces 0123456789' });
    expect(spaced.status).toBe(400);
    const nonAscii = await patch({ apiKey: '密钥-sk-key-0123456789abc' });
    expect(nonAscii.status).toBe(400);
    const notText = await patch({ apiKey: 42 });
    expect(notText.status).toBe(400);
    const messages = await Promise.all([tooShort, control, spaced, nonAscii, notText].map(async response => await response.text()));
    for (const message of messages) {
      expect(message).not.toContain('sk-short');
      expect(message).not.toContain('sk-control-char-key');
      expect(message).not.toContain('密钥-sk-key');
    }
    expect(error.mock.calls.flat().join(' ')).not.toContain('sk-control-char-key');
    expect(await bindings.DB.prepare("SELECT value FROM settings WHERE key='deepseek_api_key'").first()).toEqual({ value: validKey });
  });
  it('rejects an over-long key and values of the wrong type without storing anything', async () => {
    expect((await patch({ apiKey: 'k'.repeat(201) })).status).toBe(400);
    expect((await patch({ enabled: 'yes' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(await storedKeys()).toEqual([]);
  });
  it('toggles the switch without touching a stored key', async () => {
    await patch({ apiKey: validKey });
    const disabled = await patch({ enabled: false });
    expect(await disabled.json()).toMatchObject({ deepseek: { configured: true, enabled: false, source: 'database' } });
    expect(await getDeepSeekApiKey(bindings)).toBeNull();
    expect(await bindings.DB.prepare("SELECT value FROM settings WHERE key='deepseek_api_key'").first()).toEqual({ value: validKey });
    const enabled = await patch({ enabled: true });
    expect(await enabled.json()).toMatchObject({ deepseek: { configured: true, enabled: true } });
    expect(await getDeepSeekApiKey(bindings)).toBe(validKey);
  });
  it('refuses to enable summaries without any available key', async () => {
    const response = await patch({ enabled: true });
    expect(response.status).toBe(400);
    expect(await storedKeys()).toEqual([]);
    expect(await getDeepSeekSettings(bindings)).toEqual({ configured: false, enabled: false, model: 'deepseek-chat', source: null });
  });
});

describe('DeepSeek environment fallback and removal', () => {
  it('uses the environment key when no database override exists', async () => {
    const overrides = { DEEPSEEK_API_KEY: envKey };
    expect((await settings(overrides)).deepseek).toEqual({ configured: true, enabled: true, model: 'deepseek-chat', source: 'environment' });
    expect(await getDeepSeekApiKey({ ...bindings, DEEPSEEK_API_KEY: envKey })).toBe(envKey);
    expect((await patch({ enabled: false }, overrides)).status).toBe(200);
    expect(await getDeepSeekApiKey({ ...bindings, DEEPSEEK_API_KEY: envKey })).toBeNull();
    expect(await storedKeys()).toEqual(['deepseek_enabled']);
  });
  it('prefers the database key and restores the environment key after deletion', async () => {
    const overrides = { DEEPSEEK_API_KEY: envKey };
    expect((await patch({ apiKey: validKey }, overrides)).status).toBe(200);
    expect((await settings(overrides)).deepseek).toMatchObject({ configured: true, source: 'database', enabled: true });
    const removed = await patch({ apiKey: '' }, overrides);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deepseek: { configured: true, enabled: true, model: 'deepseek-chat', source: 'environment' } });
    expect(await storedKeys()).toEqual([]);
    expect(await getDeepSeekApiKey({ ...bindings, DEEPSEEK_API_KEY: envKey })).toBe(envKey);
  });
  it('reports an unconfigured service after removing the only key', async () => {
    await patch({ apiKey: validKey });
    const removed = await patch({ apiKey: '' });
    expect(await removed.json()).toEqual({ deepseek: { configured: false, enabled: false, model: 'deepseek-chat', source: null } });
    expect(await storedKeys()).toEqual([]);
    expect(await getDeepSeekSettings(bindings)).toEqual({ configured: false, enabled: false, model: 'deepseek-chat', source: null });
  });
  it('ignores an invalid environment key instead of calling upstream with it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await settings({ DEEPSEEK_API_KEY: 'too-short' })).deepseek).toEqual({ configured: false, enabled: false, model: 'deepseek-chat', source: null });
    expect(await getDeepSeekApiKey({ ...bindings, DEEPSEEK_API_KEY: 'too-short' })).toBeNull();
    const logged = error.mock.calls.flat().join(' ');
    expect(logged).toContain('deepseek_key_invalid');
    expect(logged).not.toContain('too-short');
  });
});
