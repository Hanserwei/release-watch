PRAGMA foreign_keys = ON;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)),
  etag TEXT,
  scan_page INTEGER NOT NULL DEFAULT 2 CHECK(scan_page >= 2),
  sweep_generation INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_success_at TEXT,
  next_check_at TEXT NOT NULL,
  error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX projects_due ON projects(next_check_at, lease_until);
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chat_id TEXT,
  include_prerelease INTEGER NOT NULL DEFAULT 0 CHECK(include_prerelease IN (0,1)),
  interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK(interval_minutes IN (15,30,60,360)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  created_at TEXT NOT NULL,
  notify_after TEXT NOT NULL,
  promotion_generation INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX subscriptions_target ON subscriptions(project_id, COALESCE(chat_id, ''));
CREATE INDEX subscriptions_project ON subscriptions(project_id, paused);
CREATE TABLE releases (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  prerelease INTEGER NOT NULL CHECK(prerelease IN (0,1)),
  published_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  notify_at TEXT NOT NULL,
  first_seen_token TEXT NOT NULL
);
CREATE INDEX releases_project ON releases(project_id, published_at DESC);
CREATE TABLE subscription_release_skips (
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  PRIMARY KEY(subscription_id, release_id)
);
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  message_id INTEGER,
  error TEXT,
  UNIQUE(chat_id, release_id)
);
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at, lease_until);
CREATE TABLE chat_delivery_locks (
  chat_id TEXT PRIMARY KEY,
  next_send_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('processing','completed')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
