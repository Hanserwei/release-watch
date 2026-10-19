-- Offsets in notification_entities refer to the persisted visible notification_text.
-- NULL retains the exact plain-text behavior of an already prepared legacy delivery.
ALTER TABLE deliveries ADD COLUMN notification_entities TEXT;
