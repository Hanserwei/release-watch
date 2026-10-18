import type { Env } from './env';

export class TelegramError extends Error {
  constructor(message: string, public retryAfter: number | null = null, public permanent = false) {
    super(message); this.name = 'TelegramError';
  }
}
export class TelegramPhotoError extends Error {
  constructor() { super('封面暂时不可用，将发送文字通知'); this.name = 'TelegramPhotoError'; }
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

export async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<number> {
  return telegramRequest(env, chatId, 'sendMessage', JSON.stringify({
    chat_id: chatId, text: text.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, ''), link_preview_options: { is_disabled: true },
  }));
}

export async function sendTelegramPhoto(env: Env, chatId: string, caption: string, coverUrl: string): Promise<number> {
  const text = caption.slice(0, 1024).replace(/[\uD800-\uDBFF]$/, '');
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
    body.set('chat_id', chatId); body.set('caption', text); body.set('photo', photo, coverUrl.split('/').pop()!);
    return telegramRequest(env, chatId, 'sendPhoto', body);
  }
  if (!coverUrl.startsWith('https://')) throw new TelegramPhotoError();
  return telegramRequest(env, chatId, 'sendPhoto', JSON.stringify({ chat_id: chatId, photo: coverUrl, caption: text }));
}
