-- 项目封面、中文摘要缓存与保留原文的通知字段。
ALTER TABLE projects ADD COLUMN cover_url TEXT;
ALTER TABLE releases ADD COLUMN changelog_zh TEXT;
ALTER TABLE deliveries ADD COLUMN notification_text TEXT;
ALTER TABLE deliveries ADD COLUMN photo_message_id INTEGER;
ALTER TABLE deliveries ADD COLUMN text_offset INTEGER NOT NULL DEFAULT 0;

-- 内置封面：内置项目默认使用随 Worker 一起发布的静态图片。
UPDATE projects SET cover_url='/covers/halo-moments.png' WHERE repo='halo-sigs/plugin-moments' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/halo-photos.png' WHERE repo='halo-sigs/plugin-photos' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/halo-links.png' WHERE repo='halo-sigs/plugin-links' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/halo-mcp.png' WHERE repo='halo-dev/plugin-mcp-server' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/halo-s3.png' WHERE repo='halo-dev/plugin-s3' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/halo.png' WHERE repo='halo-dev/halo' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/spring-modulith.png' WHERE repo='spring-projects/spring-modulith' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/spring-boot.png' WHERE repo='spring-projects/spring-boot' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/spring-grpc.png' WHERE repo='spring-projects/spring-grpc' AND cover_url IS NULL;
UPDATE projects SET cover_url='/covers/spring-ai.png' WHERE repo='spring-projects/spring-ai' AND cover_url IS NULL;
