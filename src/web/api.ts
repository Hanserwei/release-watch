import type {
  ApiError, CheckSummary, DashboardData, DeepSeekSettings, DeepSeekSettingsInput, DeepSeekSettingsResponse,
  PublicDashboardData, SubscriptionInput, SubscriptionPatch, SubscriptionView,
} from '../shared/types';

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const timeout = !init.method || init.method === 'GET' ? AbortSignal.timeout(20_000) : undefined;
  const signal = timeout ? (init.signal ? AbortSignal.any([init.signal, timeout]) : timeout) : init.signal;
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (timeout?.aborted && !init.signal?.aborted) throw new ApiRequestError('请求超时，请稍后刷新重试。', 0);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError('无法连接服务，请检查网络后重试。', 0);
  }
  if (response.status === 401) {
    throw new ApiRequestError('管理访问口令无效或已失效，请重新登录。', 401);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (timeout?.aborted && !init.signal?.aborted) throw new ApiRequestError('请求超时，请稍后刷新重试。', 0);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError('服务暂时无法响应，请稍后重试。', response.status);
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof (body as ApiError).error === 'string'
      ? (body as ApiError).error
      : '操作未完成，请稍后重试。';
    throw new ApiRequestError(message, response.status);
  }
  return body as T;
}

/**
 * DeepSeek 配置只暴露布尔与来源信息，接口固定返回 { deepseek: DeepSeekSettings }，
 * 不包含密钥、更新时间或任何可被推断的细节。
 */
export function deepSeekSettings(body: unknown): DeepSeekSettings {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const nested = record.deepseek;
  const value = typeof nested === 'object' && nested !== null ? nested as Record<string, unknown> : record;
  const source = value.source === 'database' || value.source === 'environment' ? value.source : null;
  const configured = value.configured === true && source !== null;
  return { configured, enabled: configured && value.enabled === true, model: 'deepseek-chat', source };
}

export const api = {
  health: (signal?: AbortSignal) => request<{ ok: true }>('/api/health', undefined, { signal }),
  publicDashboard: (signal?: AbortSignal) => request<PublicDashboardData>('/api/public/dashboard', undefined, { signal }),
  dashboard: (token: string, signal?: AbortSignal) => request<DashboardData>('/api/dashboard', token, { signal }),
  addSubscription: (token: string, input: SubscriptionInput, signal?: AbortSignal) => request<{ subscription: SubscriptionView }>('/api/subscriptions', token, { method: 'POST', body: JSON.stringify(input), signal }),
  updateSubscription: (token: string, id: number, input: SubscriptionPatch, signal?: AbortSignal) => request<{ subscription: SubscriptionView }>(`/api/subscriptions/${id}`, token, { method: 'PATCH', body: JSON.stringify(input), signal }),
  deleteSubscription: (token: string, id: number, signal?: AbortSignal) => request<{ ok: true }>(`/api/subscriptions/${id}`, token, { method: 'DELETE', signal }),
  check: (token: string, projectId: number, signal?: AbortSignal) => request<CheckSummary>(`/api/projects/${projectId}/check`, token, { method: 'POST', signal }),
  retryDeliveries: (token: string, signal?: AbortSignal) => request<{ ok: true }>('/api/deliveries/retry', token, { method: 'POST', signal }),
  deepSeekSettings: (token: string, signal?: AbortSignal) =>
    request<DeepSeekSettingsResponse>('/api/settings/deepseek', token, { signal }).then(deepSeekSettings),
  saveDeepSeekSettings: (token: string, input: DeepSeekSettingsInput, signal?: AbortSignal) =>
    request<DeepSeekSettingsResponse>('/api/settings/deepseek', token, { method: 'PATCH', body: JSON.stringify(input), signal }).then(deepSeekSettings),
};

export function githubUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
