import type { PublicDashboardData, PublicReleaseView, PublicStatusData, PublicSubscriptionView } from '../shared/types';
import type { Env } from './env';
import { iso } from './db';

const visibleProjects = `WITH visible_projects AS (
  SELECT p.id AS projectId,p.repo,p.cover_url AS coverUrl,
    p.last_checked_at AS lastCheckedAt,p.last_success_at AS lastSuccessAt,
    p.next_check_at AS nextCheckAt,p.initialized,
    CASE WHEN p.error IS NOT NULL THEN '检查暂时异常，请稍后查看' ELSE NULL END AS error,
    MIN(s.id) AS id,MIN(s.paused) AS paused,MAX(s.include_prerelease) AS includePrerelease,
    MIN(s.interval_minutes) AS intervalMinutes
  FROM projects p JOIN subscriptions s ON s.project_id=p.id
  WHERE p.is_public=1 AND p.visibility_checked_at>=? AND p.visibility_checked_at<=?
  GROUP BY p.id
)`;

export async function getPublicDashboard(env: Env): Promise<PublicDashboardData> {
  const now = Date.now();
  const cutoff = iso(now - 24 * 60 * 60 * 1000);
  const checkedBefore = iso(now);
  // All three reads share a transaction so a visibility change cannot split the response.
  const [projects, releases, status] = await env.DB.batch([
    env.DB.prepare(`${visibleProjects}
      SELECT v.*,
        (SELECT r.tag FROM releases r WHERE r.project_id=v.projectId AND (v.includePrerelease=1 OR r.prerelease=0)
          ORDER BY r.published_at DESC,r.id DESC LIMIT 1) AS latestTag
      FROM visible_projects v ORDER BY v.id DESC`).bind(cutoff, checkedBefore),
    env.DB.prepare(`${visibleProjects}
      SELECT r.id,r.project_id AS projectId,v.repo,v.coverUrl,r.tag,r.name,r.body,r.prerelease,
        r.published_at AS publishedAt,r.discovered_at AS discoveredAt
      FROM releases r JOIN visible_projects v ON v.projectId=r.project_id
      WHERE r.prerelease=0 OR v.includePrerelease=1
      ORDER BY r.published_at DESC,r.id DESC LIMIT 50`).bind(cutoff, checkedBefore),
    env.DB.prepare(`${visibleProjects}
      SELECT (SELECT value FROM settings WHERE key='last_cron_at') AS lastCronAt,
        COUNT(*) AS projectCount,COALESCE(SUM(paused=0),0) AS activeSubscriptions,
        COALESCE(SUM(error IS NOT NULL),0) AS errorProjects,
        COALESCE(MIN(CASE WHEN paused=0 THEN intervalMinutes END),15) AS intervalMinutes
      FROM visible_projects`).bind(cutoff, checkedBefore),
  ]);
  const subscriptions = (projects.results as unknown as Omit<PublicSubscriptionView, 'latestUrl'>[]).map(row => ({
    id: row.id, projectId: row.projectId, repo: row.repo, coverUrl: row.coverUrl ?? null,
    includePrerelease: Boolean(row.includePrerelease), intervalMinutes: row.intervalMinutes, paused: Boolean(row.paused),
    latestTag: row.latestTag,
    latestUrl: row.latestTag === null ? null : `https://github.com/${row.repo}/releases/tag/${encodeURIComponent(row.latestTag)}`,
    lastCheckedAt: row.lastCheckedAt, lastSuccessAt: row.lastSuccessAt, nextCheckAt: row.nextCheckAt,
    initialized: Boolean(row.initialized), error: row.error,
  }));
  const timeline = (releases.results as unknown as Omit<PublicReleaseView, 'url'>[]).map(row => ({
    id: row.id, projectId: row.projectId, repo: row.repo, coverUrl: row.coverUrl ?? null,
    tag: row.tag, name: row.name,
    url: `https://github.com/${row.repo}/releases/tag/${encodeURIComponent(row.tag)}`,
    body: row.body, prerelease: Boolean(row.prerelease), publishedAt: row.publishedAt, discoveredAt: row.discoveredAt,
  }));
  const totals = status.results[0] as unknown as PublicStatusData;
  return {
    subscriptions, releases: timeline,
    status: { lastCronAt: totals.lastCronAt, projectCount: totals.projectCount, activeSubscriptions: totals.activeSubscriptions,
      errorProjects: totals.errorProjects, intervalMinutes: totals.intervalMinutes },
  };
}
