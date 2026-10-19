CREATE INDEX IF NOT EXISTS releases_notify_at ON releases(notify_at);

INSERT OR IGNORE INTO settings(key,value)
  SELECT 'release_group_chat_id',value FROM settings
  WHERE key='default_chat_id' AND value GLOB '-[1-9]*' AND substr(value,2) NOT GLOB '*[^0-9]*';

INSERT OR IGNORE INTO settings(key,value)
  SELECT 'release_group_notify_after',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM settings WHERE key='release_group_chat_id';
