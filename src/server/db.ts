import type { Env } from './env';

export const iso = (time = Date.now()): string => new Date(time).toISOString();
export function bounded(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
export async function setting(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
}
export function putSetting(env: Env, key: string, value: string): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value);
}
export function retryDelay(attempt: number): number {
  return Math.min(86_400_000, 60_000 * 2 ** Math.min(Math.max(0, attempt - 1), 11));
}
