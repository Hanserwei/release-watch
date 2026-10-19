import type { Env } from './env';

export const RELEASE_GROUP_SETTING = 'release_group_chat_id';
export const RELEASE_GROUP_SINCE_SETTING = 'release_group_notify_after';

// Both queries use aliases r (release) and s (subscription), keeping pause,
// prerelease, resume and promotion-skip rules identical for direct and group delivery.
const eligibleRelease = `s.paused=0 AND (r.prerelease=0 OR s.include_prerelease=1)
  AND r.notify_at>=s.notify_after
  AND NOT EXISTS(SELECT 1 FROM subscription_release_skips k WHERE k.subscription_id=s.id AND k.release_id=r.id)`;
const validGroup = `g.value GLOB '-[1-9]*' AND substr(g.value,2) NOT GLOB '*[^0-9]*'`;

export const eligibleDelivery = `EXISTS(SELECT 1 FROM releases r JOIN subscriptions s ON s.project_id=r.project_id
  WHERE r.id=deliveries.release_id AND ${eligibleRelease}
  AND (s.chat_id=deliveries.chat_id OR EXISTS(
    SELECT 1 FROM settings g JOIN settings b ON b.key='${RELEASE_GROUP_SINCE_SETTING}'
    WHERE g.key='${RELEASE_GROUP_SETTING}' AND ${validGroup}
      AND g.value=deliveries.chat_id AND r.notify_at>=b.value)))`;

/** Adds one durable group delivery per release while preserving each original recipient. */
export async function enqueueGroupReleases(env: Env, now: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO deliveries(release_id,chat_id,created_at)
    SELECT r.id,g.value,? FROM settings g JOIN settings b ON b.key='${RELEASE_GROUP_SINCE_SETTING}'
    JOIN releases r ON r.notify_at>=b.value
    WHERE g.key='${RELEASE_GROUP_SETTING}' AND ${validGroup}
      AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.project_id=r.project_id AND ${eligibleRelease})
      AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.chat_id=g.value AND d.release_id=r.id)
    ORDER BY r.notify_at,r.id LIMIT 50
    ON CONFLICT(chat_id,release_id) DO NOTHING`).bind(now).run();
}
