BEGIN IMMEDIATE;
CREATE TABLE mileage_ocr_jobs (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES mileage_applications(id) ON DELETE CASCADE,
  source_version TEXT NOT NULL CHECK (length(source_version) = 64 AND source_version NOT GLOB '*[^0-9a-f]*'),
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'unknown')),
  clova_reserved_at TEXT,
  luna_reserved_at TEXT,
  clova_duration_ms INTEGER,
  luna_duration_ms INTEGER,
  luna_input_tokens INTEGER,
  luna_output_tokens INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(application_id, source_version, extractor_version)
) STRICT;
CREATE INDEX mileage_ocr_jobs_status_idx ON mileage_ocr_jobs(status, created_at);
CREATE INDEX mileage_ocr_jobs_clova_reservation_idx ON mileage_ocr_jobs(clova_reserved_at);
CREATE INDEX mileage_ocr_jobs_luna_reservation_idx ON mileage_ocr_jobs(luna_reserved_at);
PRAGMA user_version = 9;
COMMIT;
