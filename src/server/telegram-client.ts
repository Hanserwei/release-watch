import type { Env } from './env';
import { z } from 'zod';
import { sliceTelegramText, type TelegramText } from './telegram-text';

export class TelegramError extends Error {
  constructor(message: string, public retryAfter: number | null = null, public permanent = false) {
    super(message); this.name = 'TelegramError';
  }
}
export class TelegramPhotoError extends Error {
  constructor() { super('封面暂时不可用，将发送文字通知'); this.name = 'TelegramPhotoError'; }
}

/** Resolve the actual bot identity before acting on a group command addressed to it. */
export async function getTelegramBotUsername(env: Env): Promise<string> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new TelegramError('尚未配置 Telegram 机器人', 300);
  try {
    const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/getMe', {
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('telegram_identity_unavailable'); }
    const payload = z.object({ ok: z.literal(true), result: z.object({ username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/) }) }).parse(await response.json());
    return payload.result.username;
  } catch { throw new TelegramError('暂时无法确认机器人身份，稍后重试', 60); }
}

async function telegramRequest(env: Env, chatId: string, method: 'sendMessage' | 'sendPhoto', body: string | FormData): Promise<number> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new TelegramError('尚未配置 Telegram 机器人', 300);
  if (!/^-?\d+$/.test(chatId)) throw new TelegramError('通知目标无效，请重新绑定 Telegram', null, true);
  let response: Response;
  try {
    response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      ...(typeof body === 'string' ? { headers: { 'Content-Type': 'application/json' } } : {}), body,
    });
  } catch { throw new TelegramError('Telegram 暂时无法连接，稍后重试', 60); }
  let payload: { ok?: boolean; result?: { message_id?: number }; parameters?: { retry_after?: number } };
  try { payload = await response.json(); }
  catch { throw new TelegramError('Telegram 返回异常响应，稍后重试', 60); }
  if (!response.ok || !payload.ok || !Number.isSafeInteger(payload.result?.message_id)) {
    const retry = payload.parameters?.retry_after;
    if (response.status === 429) throw new TelegramError('Telegram 发送过于频繁，等待后重试', typeof retry === 'number' && Number.isSafeInteger(retry) && retry > 0 ? retry : 60);
    if (response.status === 401) throw new TelegramError('Telegram 机器人凭据无效，请更新配置', null, true);
    if (response.status === 403) throw new TelegramError('机器人无法发送到当前目标，请取消屏蔽后重新绑定', null, true);
    if (response.status === 400 && method === 'sendPhoto') throw new TelegramPhotoError();
    if (response.status === 400) throw new TelegramError('Telegram 通知目标不可用，请重新绑定', null, true);
    throw new TelegramError('Telegram 服务暂时不可用，稍后重试', 60);
  }
  return payload.result!.message_id!;
}

export async function sendTelegramMessage(env: Env, chatId: string, text: string | TelegramText): Promise<number> {
  const part = sliceTelegramText(text, 0, 4000);
  return telegramRequest(env, chatId, 'sendMessage', JSON.stringify({
    chat_id: chatId, text: part.text, ...(part.entities.length ? { entities: part.entities } : {}), link_preview_options: { is_disabled: true },
  }));
}

export async function sendTelegramPhoto(env: Env, chatId: string, caption: string | TelegramText, coverUrl: string): Promise<number> {
  const part = sliceTelegramText(caption, 0, 1024);
  if (/^\/covers\/[a-z0-9-]+\.png$/.test(coverUrl)) {
    // Upload bundled images directly; Telegram cannot reach a local development server.
    let photo: Blob;
    try {
      const asset = await env.ASSETS.fetch(new Request(`https://release-watch.invalid${coverUrl}`));
      if (!asset.ok || !asset.headers.get('content-type')?.startsWith('image/png')) throw new TelegramPhotoError();
      photo = await asset.blob();
      if (!photo.size || photo.size > 10_000_000) throw new TelegramPhotoError();
    } catch { throw new TelegramPhotoError(); }
    const body = new FormData();
    body.set('chat_id', chatId); body.set('caption', part.text); body.set('photo', photo, coverUrl.split('/').pop()!);
    if (part.entities.length) body.set('caption_entities', JSON.stringify(part.entities));
    return telegramRequest(env, chatId, 'sendPhoto', body);
  }
  if (!coverUrl.startsWith('https://')) throw new TelegramPhotoError();
  return telegramRequest(env, chatId, 'sendPhoto', JSON.stringify({ chat_id: chatId, photo: coverUrl, caption: part.text,
    ...(part.entities.length ? { caption_entities: part.entities } : {}),
  }));
}
