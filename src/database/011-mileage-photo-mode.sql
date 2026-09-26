BEGIN IMMEDIATE;
ALTER TABLE mileage_applications ADD COLUMN photo_mode TEXT NOT NULL DEFAULT 'separate'
  CHECK (photo_mode IN ('single', 'separate'));
ALTER TABLE mileage_ocr_jobs ADD COLUMN luna_retry_reserved_at TEXT;
CREATE INDEX mileage_ocr_jobs_luna_retry_reservation_idx ON mileage_ocr_jobs(luna_retry_reserved_at);
DROP TRIGGER mileage_applications_approved_photos_update;
CREATE TRIGGER mileage_applications_approved_photos_update
BEFORE UPDATE OF approval_status, photo_mode ON mileage_applications
WHEN NEW.approval_status = 'approved' AND (
  NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'receipt') OR
  (NEW.photo_mode = 'separate' AND NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'meter'))
)
BEGIN
  SELECT RAISE(ABORT, 'approved mileage application requires selected photos');
END;
CREATE TRIGGER mileage_applications_approved_mode_update
BEFORE UPDATE OF photo_mode ON mileage_applications
WHEN OLD.approval_status = 'approved' AND OLD.photo_mode <> NEW.photo_mode
BEGIN
  SELECT RAISE(ABORT, 'approved mileage application photos cannot be changed');
END;
PRAGMA user_version = 11;
COMMIT;
