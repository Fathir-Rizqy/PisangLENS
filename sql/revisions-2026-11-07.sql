-- Apply once after checking SHOW COLUMNS. Existing accounts keep NULL profile values.
-- Fresh installations use schema.sql instead of this migration.
-- The application account also needs SELECT/INSERT on scans, consultations and
-- chat_messages, plus UPDATE(botani_id,status) on consultations.
-- Authenticated profile completion additionally needs column-limited
-- UPDATE(name,institution,province,city) on users; no extra schema change is needed.
-- Provision a 32-byte chat master key at config.chat_master_key_file, outside
-- the webroot, before testing encrypted messages. Preserve this key across releases.
ALTER TABLE users
    ADD COLUMN institution VARCHAR(150) NULL,
    ADD COLUMN province VARCHAR(100) NULL,
    ADD COLUMN city VARCHAR(100) NULL;

-- NULL keeps legacy encrypted messages compatible. New sends must supply an IV.
ALTER TABLE chat_messages
    ADD COLUMN message_iv VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD UNIQUE KEY unique_ticket_iv (consultation_id, message_iv);
