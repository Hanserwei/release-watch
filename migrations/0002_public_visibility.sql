ALTER TABLE projects ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0,1));
ALTER TABLE projects ADD COLUMN visibility_checked_at TEXT;
