BEGIN IMMEDIATE;

ALTER TABLE mileage_applications ADD COLUMN request_hash TEXT
  CHECK (request_hash IS NULL OR (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE mileage_application_photos ADD COLUMN original_storage_key TEXT;
ALTER TABLE mileage_application_photos ADD COLUMN original_content_type TEXT;
ALTER TABLE mileage_application_photos ADD COLUMN original_byte_size INTEGER
  CHECK (original_byte_size IS NULL OR original_byte_size BETWEEN 1 AND 52428800);
CREATE UNIQUE INDEX mileage_photos_original_key_idx
  ON mileage_application_photos(original_storage_key);

-- Written before remote storage. Removed only with committed metadata or confirmed cleanup.
CREATE TABLE mileage_upload_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_keys TEXT NOT NULL CHECK (json_valid(storage_keys) AND json_array_length(storage_keys) = 4),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

PRAGMA user_version = 6;
COMMIT;
