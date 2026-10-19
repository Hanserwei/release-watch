import initialSchema from '../migrations/0001_initial.sql?raw';
import publicVisibilitySchema from '../migrations/0002_public_visibility.sql?raw';
import coverAndSettingsSchema from '../migrations/0003_cover_and_settings.sql?raw';
import newsDigestsSchema from '../migrations/0004_news_digests.sql?raw';
import releaseGroupSyncSchema from '../migrations/0005_release_group_sync.sql?raw';

async function applyMigration(db: D1Database, sql: string): Promise<void> {
  await db.batch(sql.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
}

/** 按列存在性增量应用迁移，模拟 D1 只执行尚未应用过的迁移文件。 */
async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.some(row => row.name === column);
}

export async function initializeTestSchema(db: D1Database): Promise<void> {
  const ddl = initialSchema.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/CREATE (UNIQUE )?INDEX /g, 'CREATE $1INDEX IF NOT EXISTS ');
  await applyMigration(db, ddl);
  if (!(await hasColumn(db, 'projects', 'is_public'))) await applyMigration(db, publicVisibilitySchema);
  if (!(await hasColumn(db, 'projects', 'cover_url'))) await applyMigration(db, coverAndSettingsSchema);
  await applyMigration(db, newsDigestsSchema.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS '));
  await applyMigration(db, releaseGroupSyncSchema);
}
