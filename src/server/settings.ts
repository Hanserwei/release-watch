import { AppError, type Env } from './env';
import { putSetting, setting } from './db';
import type { DeepSeekSettings } from '../shared/types';

/**
 * DeepSeek 中文摘要的管理员配置。
 *
 * 数据库只保存密钥原文与启用开关；接口、错误与日志一律只暴露布尔状态，绝不回显密钥。
 * 密钥解析顺序：settings 表 > 环境变量 DEEPSEEK_API_KEY。
 */
export const DEEPSEEK_KEY_SETTING = 'deepseek_api_key';
export const DEEPSEEK_ENABLED_SETTING = 'deepseek_enabled';
export const DEEPSEEK_KEY_MIN_LENGTH = 20;
export const DEEPSEEK_KEY_MAX_LENGTH = 200;

const visibleAscii = /^[\x21-\x7e]+$/;

/** 校验并规范化 DeepSeek 密钥；错误信息只描述规则，永不包含密钥内容。 */
export function normalizeDeepSeekKey(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('DeepSeek 密钥必须为文本');
  const key = value.trim();
  if (!key) throw new AppError('如需删除已保存的密钥，请提交 apiKey: ""');
  if (!visibleAscii.test(key)) throw new AppError('DeepSeek 密钥只能包含可见 ASCII 字符，不能含空格、控制字符或非 ASCII 字符');
  if (key.length < DEEPSEEK_KEY_MIN_LENGTH || key.length > DEEPSEEK_KEY_MAX_LENGTH) {
    throw new AppError(`DeepSeek 密钥长度需在 ${DEEPSEEK_KEY_MIN_LENGTH} 到 ${DEEPSEEK_KEY_MAX_LENGTH} 个字符之间`);
  }
  return key;
}

function readCandidate(value: string | null | undefined, source: 'database' | 'environment'): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeDeepSeekKey(value);
  } catch {
    // 非法密钥等同未配置，避免把脏数据送往上游；日志只记录事件名与来源。
    console.error(JSON.stringify({ event: 'deepseek_key_invalid', source }));
    return null;
  }
}

async function readSettings(env: Env): Promise<DeepSeekSettings & { apiKey: string | null }> {
  const [stored, enabledFlag] = await Promise.all([setting(env, DEEPSEEK_KEY_SETTING), setting(env, DEEPSEEK_ENABLED_SETTING)]);
  const fromDatabase = readCandidate(stored, 'database');
  const fromEnvironment = readCandidate(env.DEEPSEEK_API_KEY, 'environment');
  const apiKey = fromDatabase ?? fromEnvironment;
  // 未配置密钥时无论开关如何都视为关闭；配置后默认开启，除非管理员显式写入 false。
  const enabled = apiKey !== null && enabledFlag !== 'false';
  return { configured: apiKey !== null, enabled, model: 'deepseek-chat', source: fromDatabase ? 'database' : fromEnvironment ? 'environment' : null, apiKey };
}

export async function getDeepSeekSettings(env: Env): Promise<DeepSeekSettings> {
  const settings = await readSettings(env);
  return { configured: settings.configured, enabled: settings.enabled, model: settings.model, source: settings.source };
}

/** 实际用于调用 DeepSeek 的密钥；仅在配置且启用时返回，避免停用后仍外发内容。 */
export async function getDeepSeekApiKey(env: Env): Promise<string | null> {
  const { apiKey, enabled } = await readSettings(env);
  return enabled ? apiKey : null;
}

export interface DeepSeekUpdate { apiKey?: unknown; enabled?: unknown; }

/**
 * 更新密钥或启用状态。`apiKey: ""` 删除数据库中的覆盖值，回退到环境变量；
 * 同时清除启用开关，让环境变量密钥重新按默认（启用）处理。
 */
export async function updateDeepSeekSettings(env: Env, input: DeepSeekUpdate): Promise<DeepSeekSettings> {
  const hasKey = input.apiKey !== undefined;
  const hasEnabled = input.enabled !== undefined;
  if (!hasKey && !hasEnabled) throw new AppError('请提供 DeepSeek 密钥或启用状态');
  if (hasEnabled && typeof input.enabled !== 'boolean') throw new AppError('启用状态必须为布尔值');
  if (hasKey && typeof input.apiKey !== 'string') throw new AppError('DeepSeek 密钥必须为文本');
  const removing = hasKey && (input.apiKey as string).trim() === '';
  const key = hasKey && !removing ? normalizeDeepSeekKey(input.apiKey) : null;
  const fromEnvironment = readCandidate(env.DEEPSEEK_API_KEY, 'environment');
  const stored = removing ? null : readCandidate(await setting(env, DEEPSEEK_KEY_SETTING), 'database');
  // 只有确实存在可用密钥时才能启用：本次提交的密钥、库中已有值或环境变量。
  if (hasEnabled && input.enabled === true && key === null && stored === null && fromEnvironment === null) {
    throw new AppError('请先配置 DeepSeek 密钥，再启用中文摘要');
  }
  const statements: D1PreparedStatement[] = [];
  if (removing) {
    statements.push(env.DB.prepare('DELETE FROM settings WHERE key=?').bind(DEEPSEEK_KEY_SETTING));
    statements.push(env.DB.prepare('DELETE FROM settings WHERE key=?').bind(DEEPSEEK_ENABLED_SETTING));
  } else if (key) {
    statements.push(putSetting(env, DEEPSEEK_KEY_SETTING, key));
    if (hasEnabled) statements.push(putSetting(env, DEEPSEEK_ENABLED_SETTING, input.enabled === true ? 'true' : 'false'));
  } else if (hasEnabled) {
    statements.push(putSetting(env, DEEPSEEK_ENABLED_SETTING, input.enabled === true ? 'true' : 'false'));
  }
  if (statements.length === 0) return getDeepSeekSettings(env);
  await env.DB.batch(statements);
  return getDeepSeekSettings(env);
}
