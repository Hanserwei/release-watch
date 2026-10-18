import type { CheckSummary } from '../shared/types';
import { AppError, type Env } from './env';
import { bounded, iso, retryDelay } from './db';
import { fetchReleasePage, fetchRepositoryVisibility, GitHubError, type GitHubRelease } from './github';

interface Project { id: number; repo: string; etag: string | null; scan_page: number; error_count: number; }
const leaseMs = 90_000;
async function savePage(env: Env, project: Project, token: string, page: number, releases: GitHubRelease[], etag: string | null, hasNext: boolean): Promise<number> {
  const nowMs = Date.now();
  const now = iso(nowMs);
  const guard = 'EXISTS(SELECT 1 FROM projects WHERE id=? AND lease_token=? AND lease_until>?)';
  const pageToken = crypto.randomUUID();
  const payload = JSON.stringify(releases);
  // Four SQL statements per page regardless of the number of releases or subscribers.
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO subscription_release_skips(subscription_id,release_id)
      SELECT s.id,r.id FROM json_each(?) j JOIN releases r ON r.id=json_extract(j.value,'$.id')
      JOIN subscriptions s ON s.project_id=r.project_id
      WHERE r.prerelease=1 AND json_extract(j.value,'$.prerelease')=0
      AND s.paused=1 AND ${guard}
      ON CONFLICT DO NOTHING`).bind(payload, project.id, token, nowMs),
    env.DB.prepare(`INSERT INTO releases(id,project_id,tag,name,url,body,prerelease,published_at,discovered_at,notify_at,first_seen_token)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.tag'),json_extract(value,'$.name'),
        json_extract(value,'$.url'),json_extract(value,'$.body'),json_extract(value,'$.prerelease'),
        json_extract(value,'$.publishedAt'),?,json_extract(value,'$.publishedAt'),? FROM json_each(?) WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET tag=excluded.tag,name=excluded.name,url=excluded.url,body=excluded.body,
        changelog_zh=CASE WHEN releases.body=excluded.body AND releases.tag=excluded.tag THEN releases.changelog_zh ELSE NULL END,
        notify_at=CASE WHEN releases.prerelease=1 AND excluded.prerelease=0 THEN ? ELSE releases.notify_at END,
        prerelease=excluded.prerelease,published_at=excluded.published_at WHERE releases.project_id=excluded.project_id
      RETURNING first_seen_token`).bind(project.id, now, pageToken, payload, project.id, token, nowMs, now),
    env.DB.prepare(`INSERT INTO deliveries(release_id,chat_id,created_at)
      SELECT r.id,s.chat_id,? FROM json_each(?) j JOIN releases r ON r.id=json_extract(j.value,'$.id')
      JOIN subscriptions s ON s.project_id=r.project_id
      WHERE s.chat_id IS NOT NULL AND s.paused=0 AND r.notify_at>=s.notify_after
      AND (r.prerelease=0 OR s.include_prerelease=1) AND ${guard}
      AND NOT EXISTS(SELECT 1 FROM subscription_release_skips k WHERE k.subscription_id=s.id AND k.release_id=r.id)
      ON CONFLICT(chat_id,release_id) DO NOTHING`).bind(now, payload, project.id, token, nowMs),
  ];
  if (page === 1) {
    // The latest page establishes the baseline; older pages are a separate background sweep.
    statements.push(env.DB.prepare(`UPDATE projects SET etag=?,initialized=1,
      sweep_generation=sweep_generation+CASE WHEN ?=0 THEN 1 ELSE 0 END,
      scan_page=CASE WHEN ?=0 THEN 2 ELSE scan_page END WHERE id=? AND lease_token=? AND lease_until>?`).bind(etag, Number(hasNext), Number(hasNext), project.id, token, nowMs));
  } else {
    statements.push(env.DB.prepare(`UPDATE projects SET scan_page=?,
      sweep_generation=sweep_generation+CASE WHEN ?=0 THEN 1 ELSE 0 END
      WHERE id=? AND lease_token=? AND lease_until>?`).bind(hasNext ? page + 1 : 2, Number(hasNext), project.id, token, nowMs));
  }
  const results = await env.DB.batch<{ first_seen_token?: string }>(statements);
  return results[3].meta.changes ? results[1].results.filter(row => row.first_seen_token === pageToken).length : 0;
}
async function checkProject(env: Env, id: number, force: boolean): Promise<CheckSummary> {
  const nowMs = Date.now();
  const token = crypto.randomUUID();
  const project = await env.DB.prepare(`UPDATE projects SET lease_token=?,lease_until=?,last_checked_at=?
    WHERE id=? AND lease_until<=? AND (?=1 OR next_check_at<=?) RETURNING id,repo,etag,scan_page,error_count`)
    .bind(token, nowMs + leaseMs, iso(nowMs), id, nowMs, Number(force), iso(nowMs)).first<Project>();
  if (!project) return { checked: 0, discovered: 0, errors: 0 };
  let discovered = 0;
  let visibilityChecked = false;
  try {
    const isPublic = await fetchRepositoryVisibility(env, project.repo);
    const checkedAt = Date.now();
    await env.DB.prepare('UPDATE projects SET is_public=?,visibility_checked_at=? WHERE id=? AND lease_token=? AND lease_until>?')
      .bind(Number(isPublic), iso(checkedAt), id, token, checkedAt).run();
    visibilityChecked = true;
    const head = await fetchReleasePage(env, project.repo, 1, project.etag);
    if (!head.notModified) discovered += await savePage(env, project, token, 1, head.releases, head.etag, head.hasNext);
    else {
      // A conditional response also confirms a previously persisted latest-page baseline.
      await env.DB.prepare('UPDATE projects SET initialized=1 WHERE id=? AND lease_token=? AND lease_until>? AND initialized=0')
        .bind(id, token, Date.now()).run();
    }
    // Always sweep old pages after a 304. A promotion can occur arbitrarily far behind page 1.
    if (head.notModified || head.hasNext) {
      const older = await fetchReleasePage(env, project.repo, project.scan_page);
      discovered += await savePage(env, project, token, project.scan_page, older.releases, null, older.hasNext);
    }
    const finished = Date.now();
    await env.DB.batch([env.DB.prepare(`UPDATE projects SET last_success_at=?,error=NULL,error_count=0,
      next_check_at=strftime('%Y-%m-%dT%H:%M:%fZ',?, '+' ||
        COALESCE((SELECT MIN(interval_minutes) FROM subscriptions WHERE project_id=? AND paused=0),15) || ' minutes'),
      lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=? AND lease_until>?`)
      .bind(iso(finished), iso(finished), id, id, token, finished)]);
    return { checked: 1, discovered, errors: 0 };
  } catch (error) {
    const failed = Date.now();
    const message = error instanceof GitHubError ? error.message : '检查暂时失败，稍后自动重试';
    const retryAt = Math.max(failed + retryDelay(project.error_count + 1), error instanceof GitHubError ? error.retryAt ?? 0 : 0);
    await env.DB.prepare(`UPDATE projects SET error=?,error_count=error_count+1,next_check_at=?,lease_token=NULL,lease_until=0,
      is_public=CASE WHEN ?=1 THEN is_public ELSE 0 END
      WHERE id=? AND lease_token=? AND lease_until>?`).bind(message, iso(retryAt), Number(visibilityChecked), id, token, failed).run();
    return { checked: 1, discovered, errors: 1 };
  }
}
export async function runChecks(env: Env, options: { projectId?: number; force?: boolean } = {}): Promise<CheckSummary> {
  let ids: number[];
  if (options.projectId !== undefined) {
    const project = await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(options.projectId).first<{ id: number }>();
    if (!project) throw new AppError('项目不存在', 404);
    ids = [project.id];
  } else {
    const { results } = await env.DB.prepare(`SELECT p.id FROM projects p WHERE p.next_check_at<=? AND p.lease_until<=?
      AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.project_id=p.id AND s.paused=0)
      ORDER BY p.next_check_at,p.id LIMIT ?`).bind(iso(), Date.now(), bounded(env.POLL_BATCH_SIZE, 3, 3)).all<{ id: number }>();
    ids = results.map(row => row.id);
  }
  const summary: CheckSummary = { checked: 0, discovered: 0, errors: 0 };
  // Two workers and at most two 15-item pages per project cap subrequests and D1/CPU work.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const result = await checkProject(env, id, options.force ?? false);
      summary.checked += result.checked; summary.discovered += result.discovered; summary.errors += result.errors;
    }
  }));
  return summary;
}
