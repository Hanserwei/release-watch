import { AppError, type Env } from './env';
import { constantTimeEqual } from './security';
import { normalizeRepo } from './github';
import { addSubscription, bindDefaultChat, listSubscriptions, removeSubscription } from './subscriptions';
import { getStatus } from './queries';
import { sendTelegramMessage, TelegramError } from './telegram-client';

const MAX_BODY_BYTES = 65_536;
const MAX_TEXT_LENGTH = 4096;
const LEASE_MS = 120_000;
const HELP = [
  'GitHub Release 订阅助手：',
  '/start — 将当前私聊绑定为默认通知目标',
  '/sub owner/repo [--pre] — 订阅仓库，--pre 包含预发布',
  '/unsub owner/repo — 取消当前私聊的仓库订阅',
  '/list — 查看当前私聊的订阅',
  '/status — 查看服务配置与运行状态',
  '/help — 查看帮助',
].join('\n');

type ObjectValue = Record<string, unknown>;
type IncomingMessage = { chatId: string; text: string };
type CommandResult = { text: string; retry?: boolean };

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function response(status: number, error?: string, retry: boolean | number = false): Response {
  return Response.json(error ? { error } : { ok: true }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...(retry ? { 'Retry-After': String(retry === true ? 5 : retry) } : {}) },
  });
}

async function readUpdate(request: Request): Promise<ObjectValue> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AppError('请使用 JSON 请求', 415);
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new AppError('请求内容过大或长度无效', 413);
  }
  if (!request.body) throw new AppError('请求内容为空');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AppError('请求内容过大', 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('无法读取请求内容');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let update: unknown;
  try { update = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new AppError('请求内容不是有效的 JSON'); }
  if (!object(update) || !Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) {
    throw new AppError('Telegram update 格式无效');
  }
  return update;
}

function authorizedMessage(update: ObjectValue, allowedUserId: string): IncomingMessage | null {
  // Ignore non-message updates, groups, channels and anonymous senders without side effects.
  const message = update.message;
  if (!object(message) || !object(message.from) || !object(message.chat)) return null;
  if (!positiveId(message.from.id) || String(message.from.id) !== allowedUserId || message.from.is_bot === true) return null;
  if (message.chat.type !== 'private' || !positiveId(message.chat.id) || message.chat.id !== message.from.id) return null;
  if (message.sender_chat !== undefined) return null;
  if (typeof message.text !== 'string') return null;
  if (message.text.length > MAX_TEXT_LENGTH) throw new AppError('消息文字过长', 413);
  return { chatId: String(message.chat.id), text: message.text.trim() };
}

function repository(value: string | undefined): string | null {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  try { return normalizeRepo(value); } catch { return null; }
}

async function executeCommand(env: Env, message: IncomingMessage): Promise<CommandResult> {
  const [rawCommand = '', ...args] = message.text.split(/\s+/);
  const match = /^\/(start|sub|unsub|list|status|help)(?:@[A-Za-z0-9_]{5,32})?$/i.exec(rawCommand);
  const command = match?.[1].toLowerCase();
  if (!command) return { text: '未识别的命令，请发送 /help 查看用法。' };
  if (command === 'help') return { text: HELP };
  if (command === 'start') {
    await bindDefaultChat(env, message.chatId);
    return { text: '已将当前私聊绑定为默认通知目标，尚未绑定的订阅也会发送到这里。\n后续发现的新 Release 会通知你。\n\n' + HELP };
  }
  if (command === 'sub') {
    const repo = repository(args[0]);
    if (!repo || args.length > 2 || (args.length === 2 && args[1] !== '--pre')) {
      return { text: '用法：/sub owner/repo [--pre]\n例如：/sub vitejs/vite --pre' };
    }
    const subscription = await addSubscription(env, { repo, chatId: message.chatId, includePrerelease: args[1] === '--pre' });
    return { text: `已订阅 ${subscription.repo}${subscription.includePrerelease ? '（含预发布）' : '（正式版本）'}。新发现的 Release 将发送到当前私聊。` };
  }
  if (command === 'unsub') {
    const repo = repository(args[0]);
    if (!repo || args.length !== 1) return { text: '用法：/unsub owner/repo' };
    const subscriptions = await listSubscriptions(env, message.chatId);
    const matches = subscriptions.filter(item => item.chatId === message.chatId && item.repo.toLowerCase() === repo.toLowerCase());
    for (const item of matches) {
      try { await removeSubscription(env, item.id, message.chatId); }
      catch (error) {
        // Another command or the dashboard may have removed this subscription already.
        if (!(error instanceof AppError) || error.status !== 404) throw error;
      }
    }
    return { text: matches.length ? `已取消当前私聊对 ${repo} 的订阅。` : `当前私聊尚未订阅 ${repo}。` };
  }
  if (command === 'list') {
    const subscriptions = (await listSubscriptions(env, message.chatId)).filter(item => item.chatId === message.chatId);
    if (!subscriptions.length) return { text: '当前私聊还没有订阅，发送 /sub owner/repo 开始订阅。' };
    const shown = subscriptions.slice(0, 20);
    const lines = shown.map(item =>
      `${item.repo} · ${item.includePrerelease ? '含预发布' : '正式版本'} · ${item.intervalMinutes} 分钟${item.paused ? ' · 已暂停' : ''}`,
    );
    if (subscriptions.length > shown.length) lines.push(`另有 ${subscriptions.length - shown.length} 个订阅，请在网页查看完整列表。`);
    return { text: '当前私聊的订阅：\n' + lines.join('\n') };
  }
  const status = await getStatus(env);
  return { text: [
    '服务状态：',
    `GitHub 凭据：${status.githubConfigured ? '已配置' : '未配置，请设置 GITHUB_TOKEN'}（不显示凭据内容）`,
    `Telegram 机器人：${status.telegramConfigured ? '已配置' : '未配置，请设置 TELEGRAM_BOT_TOKEN'}`,
    `Webhook：${status.webhookConfigured ? '已配置' : '未配置，请检查 Webhook secret 与用户白名单'}`,
    `默认通知目标：${status.telegramBound ? '已绑定' : '尚未绑定，请发送 /start'}`,
    `启用订阅：${status.activeSubscriptions}；检查异常项目：${status.errorProjects}`,
    `待发送：${status.pendingDeliveries}；失败：${status.failedDeliveries}；已发送：${status.sentDeliveries}`,
    `最近定时检查：${status.lastCronAt ?? '尚未运行'}`,
    `最近成功发送：${status.lastDeliveryAt ?? '暂无记录'}`,
  ].join('\n') };
}

function commandFailure(error: unknown): CommandResult {
  // Never echo upstream error messages: they can contain URLs, tokens or payloads.
  if (error instanceof AppError) {
    if (error.status === 404) return { text: '找不到该 GitHub 仓库，请检查 owner/repo；私有仓库还需配置有访问权限的 GITHUB_TOKEN。' };
    if (error.status === 429) return { text: 'GitHub 请求暂时受限，请稍后重试。系统会保留本次请求并重试。', retry: true };
    if (error.status >= 500) return { text: 'GitHub 或服务暂时不可用，请检查 GITHUB_TOKEN 配置或稍后再试。系统会重试本次请求。', retry: true };
    if (error.status === 400 || error.status === 422) return { text: '订阅参数无效，请检查 owner/repo 并发送 /help 查看用法。' };
  }
  return { text: '服务暂时无法处理命令，请稍后重试。系统会保留本次请求，配置或服务恢复后继续处理。', retry: true };
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('仅支持 POST 请求', { status: 405, headers: { Allow: 'POST' } });
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret?.trim()) return response(503, '尚未配置 Telegram Webhook secret', true);
  const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!provided || !constantTimeEqual(provided, secret)) return response(401, 'Telegram Webhook 验证失败');
  const allowed = env.TELEGRAM_ALLOWED_USER_ID;
  if (!allowed || !/^[1-9]\d*$/.test(allowed) || !Number.isSafeInteger(Number(allowed))) {
    return response(503, '尚未正确配置 Telegram 用户白名单', true);
  }
  let update: ObjectValue;
  let message: IncomingMessage | null;
  try {
    update = await readUpdate(request);
    message = authorizedMessage(update, allowed);
  } catch (error) {
    if (error instanceof AppError) return response(error.status, error.message);
    return response(400, 'Telegram 请求格式无效');
  }
  if (!message) return response(200);
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) return response(503, '尚未配置 Telegram 机器人，无法回复，请设置 TELEGRAM_BOT_TOKEN', true);

  const updateId = update.update_id as number;
  const token = crypto.randomUUID();
  let claimed = false;
  let chatClaimed = false;
  let retryAt = 0;
  let nextSendAt = 0;
  try {
    const now = Date.now();
    const row = await env.DB.prepare(`
      INSERT INTO telegram_updates (update_id, status, lease_token, lease_until, updated_at)
      VALUES (?, 'processing', ?, ?, ?)
      ON CONFLICT(update_id) DO UPDATE SET
        status = 'processing', lease_token = excluded.lease_token,
        lease_until = excluded.lease_until, updated_at = excluded.updated_at
      WHERE telegram_updates.status = 'processing' AND telegram_updates.lease_until <= ?
      RETURNING update_id
    `).bind(updateId, token, now + LEASE_MS, now, now).first<{ update_id: number }>();
    if (!row) {
      const existing = await env.DB.prepare('SELECT status, lease_token, lease_until FROM telegram_updates WHERE update_id = ?')
        .bind(updateId).first<{ status: string; lease_token: string | null; lease_until: number }>();
      return existing?.status === 'completed' ? response(200) : response(503, '该请求正在处理中，请稍后重试',
        existing?.lease_token === null ? Math.max(1, Math.ceil((existing.lease_until - Date.now()) / 1000)) : true);
    }
    claimed = true;
    let result: CommandResult;
    try { result = await executeCommand(env, message); }
    catch (error) { result = commandFailure(error); }
    const renewedAt = Date.now();
    const renewed = await env.DB.prepare(`
      UPDATE telegram_updates SET lease_until = ?, updated_at = ?
      WHERE update_id = ? AND status = 'processing' AND lease_token = ? AND lease_until > ?
      RETURNING update_id
    `).bind(renewedAt + LEASE_MS, renewedAt, updateId, token, renewedAt).first();
    if (!renewed) throw new Error('Update lease lost');
    const chatNow = Date.now();
    const chat = await env.DB.prepare(`
      INSERT INTO chat_delivery_locks (chat_id, next_send_at, lease_token, lease_until)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM telegram_updates
        WHERE update_id = ? AND status = 'processing' AND lease_token = ? AND lease_until > ?
      )
      ON CONFLICT(chat_id) DO UPDATE SET next_send_at = excluded.next_send_at,
        lease_token = excluded.lease_token, lease_until = excluded.lease_until
      WHERE chat_delivery_locks.next_send_at <= ? AND chat_delivery_locks.lease_until <= ?
      RETURNING chat_id
    `).bind(message.chatId, chatNow + 1000, token, chatNow + 30_000, updateId, token, chatNow, chatNow, chatNow).first();
    if (!chat) return response(503, '该会话正在发送消息，请稍后重试', true);
    chatClaimed = true;
    await sendTelegramMessage(env, message.chatId, result.text);
    nextSendAt = Date.now() + 1000;
    if (result.retry) {
      retryAt = Date.now() + 60_000;
      return response(503, '服务暂时不可用，本次命令将重试', 60);
    }
    const completedAt = Date.now();
    const completed = await env.DB.prepare(`
      UPDATE telegram_updates SET status = 'completed', lease_token = NULL, lease_until = 0, updated_at = ?
      WHERE update_id = ? AND status = 'processing' AND lease_token = ? AND lease_until > ?
      RETURNING update_id
    `).bind(completedAt, updateId, token, completedAt).first();
    if (!completed) throw new Error('Update lease lost');
    claimed = false;
    return response(200);
  } catch (error) {
    const retrySeconds = error instanceof TelegramError ? (error.retryAfter ?? 60) : 60;
    retryAt = Date.now() + retrySeconds * 1000;
    nextSendAt = Math.max(nextSendAt, retryAt);
    return response(503, 'Telegram 命令处理暂时失败，请稍后重试', retrySeconds);
  } finally {
    if (chatClaimed) {
      try {
        await env.DB.prepare(`
          UPDATE chat_delivery_locks SET next_send_at = MAX(next_send_at, ?), lease_token = NULL, lease_until = 0
          WHERE chat_id = ? AND lease_token = ?
        `).bind(Math.max(nextSendAt, Date.now() + 1000), message.chatId, token).run();
      } catch { /* A failed release remains recoverable after the lease expires. */ }
    }
    if (claimed) {
      try {
        await env.DB.prepare(`
          UPDATE telegram_updates SET lease_token = NULL, lease_until = ?, updated_at = ?
          WHERE update_id = ? AND status = 'processing' AND lease_token = ?
        `).bind(retryAt, Date.now(), updateId, token).run();
      } catch { /* A failed release remains recoverable after the lease expires. */ }
    }
  }
}
