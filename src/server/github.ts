import { AppError, type Env } from './env';

export interface GitHubRelease {
  id: number; tag: string; name: string; url: string; body: string;
  prerelease: boolean; publishedAt: string;
}
export class GitHubError extends Error {
  constructor(message: string, public retryAt: number | null = null) { super(message); this.name = 'GitHubError'; }
}
export function normalizeRepo(input: string): string {
  if (typeof input !== 'string' || input.length > 250) throw new AppError('请输入有效的 GitHub owner/repo 或 github.com 仓库链接');
  let repo = input.trim();
  if (/^https:\/\//i.test(repo)) {
    if (!/^https:\/\/github\.com\//i.test(repo) || /[\\%]/.test(repo) || /\/\.{1,2}(?:\/|$)/.test(repo)) throw new AppError('只支持完整的 github.com owner/repo 仓库链接');
    let url: URL;
    try { url = new URL(repo); } catch { throw new AppError('GitHub 仓库地址格式不正确'); }
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new AppError('只支持 github.com 仓库链接');
    repo = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  repo = repo.replace(/\.git$/i, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(repo) || ['.', '..'].includes(repo.split('/')[1])) {
    throw new AppError('仓库格式必须为 owner/repo 或 https://github.com/owner/repo');
  }
  return repo.toLowerCase();
}
function headers(env: Env): Headers {
  const result = new Headers({ Accept: 'application/vnd.github+json', 'User-Agent': 'release-watch', 'X-GitHub-Api-Version': '2022-11-28' });
  if (env.GITHUB_TOKEN) result.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
  return result;
}
async function request(env: Env, path: string, requestHeaders: Headers): Promise<Response> {
  if (!env.GITHUB_TOKEN) throw new GitHubError('尚未配置 GitHub Token，请先完成服务配置');
  let response: Response;
  try { response = await fetch(`https://api.github.com${path}`, { headers: requestHeaders, redirect: 'manual', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new GitHubError('GitHub 暂时无法连接，稍后重试'); }
  if (response.status === 304 || response.ok) return response;
  if (response.status === 404) throw new GitHubError('GitHub 仓库不存在，或当前凭据无权访问');
  if (response.status === 403 || response.status === 429) {
    const now = Date.now();
    const retry = response.headers.get('Retry-After');
    const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry ?? '');
    const reset = Number(response.headers.get('X-RateLimit-Reset')) * 1000;
    const retryAt = Math.max(now + 60_000, Number.isFinite(seconds) ? seconds : 0, Number.isFinite(reset) ? reset : 0);
    throw new GitHubError('GitHub 请求受限，等待限额恢复后重试', retryAt);
  }
  if (response.status === 401) throw new GitHubError('GitHub 凭据无效，请更新配置');
  throw new GitHubError(`GitHub 服务请求失败（HTTP ${response.status}）`);
}
export async function fetchRepositoryVisibility(env: Env, repo: string): Promise<boolean> {
  const response = await request(env, `/repos/${normalizeRepo(repo)}`, headers(env));
  let payload: unknown;
  try { payload = await response.json(); } catch { return false; }
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).private === false);
}
export async function verifyRepository(env: Env, repo: string): Promise<boolean> {
  if (!env.GITHUB_TOKEN) throw new AppError('尚未配置 GitHub Token，请先完成服务配置', 503);
  try { return await fetchRepositoryVisibility(env, repo); }
  catch (error) {
    if (error instanceof GitHubError) throw new AppError(error.message, error.retryAt ? 429 : error.message.includes('不存在') ? 404 : 502);
    throw error;
  }
}
export async function fetchReleasePage(env: Env, repo: string, page: number, etag?: string | null): Promise<{ releases: GitHubRelease[]; etag: string | null; notModified: boolean; hasNext: boolean }> {
  const safeRepo = normalizeRepo(repo);
  if (!Number.isSafeInteger(page) || page < 1) throw new GitHubError('分页游标无效');
  const requestHeaders = headers(env);
  if (etag) requestHeaders.set('If-None-Match', etag);
  const response = await request(env, `/repos/${safeRepo}/releases?per_page=15&page=${page}`, requestHeaders);
  if (response.status === 304) return { releases: [], etag: etag ?? null, notModified: true, hasNext: false };
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new GitHubError('GitHub 返回无效的版本数据'); }
  if (!Array.isArray(payload) || payload.length > 15) throw new GitHubError('GitHub 返回无效的版本列表');
  const releases: GitHubRelease[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') throw new GitHubError('GitHub 版本数据格式不正确');
    const value = item as Record<string, unknown>;
    if (value.draft === true) continue;
    if (!Number.isSafeInteger(value.id) || (value.id as number) < 1 || typeof value.tag_name !== 'string' || typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at)) || typeof value.prerelease !== 'boolean') throw new GitHubError('GitHub 版本数据格式不正确');
    // Construct display links on a fixed trusted origin; never follow API-provided URLs.
    releases.push({ id: value.id as number, tag: value.tag_name.slice(0, 500), name: typeof value.name === 'string' ? value.name.slice(0, 500) : value.tag_name.slice(0, 500), url: `https://github.com/${safeRepo}/releases/tag/${encodeURIComponent(value.tag_name)}`, body: typeof value.body === 'string' ? value.body : '', prerelease: value.prerelease, publishedAt: new Date(value.published_at).toISOString() });
  }
  return { releases, etag: response.headers.get('ETag'), notModified: false, hasNext: /<[^>]+>;\s*rel="next"/.test(response.headers.get('Link') ?? '') || payload.length === 15 };
}
