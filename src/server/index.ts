import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppError, type Env } from './env';
import { constantTimeEqual } from './security';
import { addSubscription, listSubscriptions, removeSubscription, updateSubscription } from './subscriptions';
import { getStatus, listReleases, retryFailedDeliveries } from './queries';
import { getPublicDashboard } from './public';
import { getDeepSeekSettings, updateDeepSeekSettings } from './settings';
import { runChecks } from './poller';
import { deliverPending } from './deliveries';
import { handleTelegramWebhook } from './telegram';
import type { SubscriptionInput, SubscriptionPatch } from '../shared/types';

const app = new Hono<{ Bindings: Env }>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  if (c.req.method === 'GET' && (c.req.path === '/api/health' || c.req.path === '/api/public/dashboard')) return next();
  const secret = c.env.ADMIN_TOKEN;
  if (!secret || secret.length < 24) return c.json({ error: '管理访问口令尚未配置，请先完成服务配置' }, 503);
  const header = c.req.header('Authorization') ?? '';
  if (!header.startsWith('Bearer ') || !constantTimeEqual(header.slice(7), secret)) return c.json({ error: '访问口令不正确或已失效' }, 401);
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 16_384, onError: c => c.json({ error: '请求内容过大' }, 413) }));
app.get('/api/health', c => c.json({ ok: true }));
app.get('/api/public/dashboard', async c => c.json(await getPublicDashboard(c.env)));
app.get('/api/dashboard', async c => {
  const [subscriptions, releases, status] = await Promise.all([listSubscriptions(c.env), listReleases(c.env, 50), getStatus(c.env)]);
  return c.json({ subscriptions, releases, status });
});

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new AppError('请使用 JSON 请求', 415);
  let value: unknown;
  try { value = await request.json(); } catch { throw new AppError('请求内容不是有效的 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('请求内容格式不正确');
  return value as Record<string, unknown>;
}
function positiveId(value: string): number {
  if (!/^[1-9]\d{0,12}$/.test(value)) throw new AppError('无效的记录编号');
  return Number(value);
}
function subscriptionFields(value: Record<string, unknown>, partial: boolean): SubscriptionInput | SubscriptionPatch {
  if (!partial && (typeof value.repo !== 'string' || value.repo.length > 250)) throw new AppError('请输入 GitHub 仓库地址或 owner/repo');
  if (value.includePrerelease !== undefined && typeof value.includePrerelease !== 'boolean') throw new AppError('预发布设置必须为布尔值');
  if (value.paused !== undefined && typeof value.paused !== 'boolean') throw new AppError('暂停设置必须为布尔值');
  if (value.intervalMinutes !== undefined && ![15, 30, 60, 360].includes(value.intervalMinutes as number)) throw new AppError('检查间隔请选择 15、30、60 或 360 分钟');
  // 封面由订阅模块统一校验与规范化，null 表示移除。
  if (value.coverUrl !== undefined && value.coverUrl !== null && typeof value.coverUrl !== 'string') throw new AppError('封面地址必须为文本或 null');
  const cover = value.coverUrl !== undefined ? { coverUrl: value.coverUrl as string | null } : {};
  if (partial) return { ...(value.includePrerelease !== undefined ? { includePrerelease: value.includePrerelease as boolean } : {}), ...(value.intervalMinutes !== undefined ? { intervalMinutes: value.intervalMinutes as number } : {}), ...(value.paused !== undefined ? { paused: value.paused as boolean } : {}), ...cover };
  return { repo: value.repo as string, ...(value.includePrerelease !== undefined ? { includePrerelease: value.includePrerelease as boolean } : {}), ...(value.intervalMinutes !== undefined ? { intervalMinutes: value.intervalMinutes as number } : {}), ...cover };
}
app.post('/api/subscriptions', async c => {
  const input = subscriptionFields(await jsonObject(c.req.raw), false) as SubscriptionInput;
  return c.json({ subscription: await addSubscription(c.env, input) }, 201);
});
app.patch('/api/subscriptions/:id', async c => {
  const patch = subscriptionFields(await jsonObject(c.req.raw), true) as SubscriptionPatch;
  return c.json({ subscription: await updateSubscription(c.env, positiveId(c.req.param('id')), patch) });
});
app.delete('/api/subscriptions/:id', async c => {
  await removeSubscription(c.env, positiveId(c.req.param('id')));
  return c.json({ ok: true });
});
app.get('/api/settings/deepseek', async c => c.json({ deepseek: await getDeepSeekSettings(c.env) }));
app.patch('/api/settings/deepseek', async c => {
  const body = await jsonObject(c.req.raw);
  return c.json({ deepseek: await updateDeepSeekSettings(c.env, { apiKey: body.apiKey, enabled: body.enabled }) });
});
app.post('/api/projects/:id/check', async c => {
  const summary = await runChecks(c.env, { projectId: positiveId(c.req.param('id')), force: true });
  await deliverPending(c.env);
  return c.json(summary);
});
app.post('/api/deliveries/retry', async c => {
  await retryFailedDeliveries(c.env);
  return c.json({ ok: true });
});
app.all('/telegram/webhook', c => handleTelegramWebhook(c.req.raw, c.env));
app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  if (error instanceof AppError) return c.json({ error: error.message }, error.status as 400);
  // 只记录事件名与错误类型：异常文本可能包含密钥或上游响应内容。
  console.error(JSON.stringify({ event: 'request_failed', name: error.name }));
  return c.json({ error: '服务暂时不可用，请稍后重试' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_cron_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(now).run();
      try { await runChecks(env); }
      catch { console.error(JSON.stringify({ event: 'scheduled_check_failed' })); }
      try { await deliverPending(env); }
      catch { console.error(JSON.stringify({ event: 'scheduled_delivery_failed' })); }
    })());
  },
} satisfies ExportedHandler<Env>;
