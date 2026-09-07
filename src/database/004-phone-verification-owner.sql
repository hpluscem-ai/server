BEGIN IMMEDIATE;
ALTER TABLE phone_verifications ADD COLUMN scope_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
PRAGMA user_version = 4;
COMMIT;
