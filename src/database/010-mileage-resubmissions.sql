BEGIN IMMEDIATE;

-- Keep the creation key/hash on the application; each resubmission has its own replay record.
CREATE TABLE mileage_resubmissions (
  id INTEGER PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES mileage_applications(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  previous_version TEXT NOT NULL CHECK (length(previous_version) = 64 AND previous_version NOT GLOB '*[^0-9a-f]*'),
  submission_version TEXT NOT NULL CHECK (length(submission_version) = 64 AND submission_version NOT GLOB '*[^0-9a-f]*'),
  previous_rejection_reason TEXT,
  previous_decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (application_id, idempotency_key)
) STRICT;

-- One selected photo has an original and a normalized object; two photos have four.
CREATE TABLE mileage_upload_attempts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_keys TEXT NOT NULL CHECK (
    json_valid(storage_keys) AND json_type(storage_keys) = 'array'
    AND json_array_length(storage_keys) IN (2, 4)
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
INSERT INTO mileage_upload_attempts_new SELECT * FROM mileage_upload_attempts;
DROP TABLE mileage_upload_attempts;
ALTER TABLE mileage_upload_attempts_new RENAME TO mileage_upload_attempts;

PRAGMA user_version = 10;
COMMIT;
