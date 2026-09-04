-- Initial schema for user_version 1. Later versions require an explicit migration.
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS logistics_companies (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  business_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  corporate_registration_number TEXT NOT NULL UNIQUE,
  business_address TEXT NOT NULL,
  manager_name TEXT NOT NULL,
  manager_phone TEXT NOT NULL,
  bank_code TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_holder TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  logistics_company_id TEXT REFERENCES logistics_companies(id) ON DELETE RESTRICT,
  service_terms_consent INTEGER NOT NULL DEFAULT 0 CHECK (service_terms_consent IN (0, 1)),
  privacy_terms_consent INTEGER NOT NULL DEFAULT 0 CHECK (privacy_terms_consent IN (0, 1)),
  marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0, 1)),
  deactivated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    role = 'admin' OR (
      phone IS NOT NULL AND
      logistics_company_id IS NOT NULL AND
      service_terms_consent = 1 AND
      privacy_terms_consent = 1
    )
  )
) STRICT;

CREATE TABLE IF NOT EXISTS installation_sites (
  id TEXT PRIMARY KEY,
  pole TEXT NOT NULL,
  business_name TEXT NOT NULL,
  area TEXT NOT NULL,
  road_address TEXT NOT NULL,
  site_type TEXT NOT NULL CHECK (site_type IN ('station', 'direct_sales')),
  note TEXT,
  latitude REAL,
  longitude REAL,
  coordinate_source TEXT,
  coordinate_verified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (coordinate_verified_at IS NULL OR latitude IS NOT NULL),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
) STRICT;

CREATE TABLE IF NOT EXISTS installation_site_devices (
  id TEXT PRIMARY KEY,
  installation_site_id TEXT NOT NULL REFERENCES installation_sites(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  capacity_liters INTEGER NOT NULL CHECK (capacity_liters > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  logistics_company_id TEXT NOT NULL REFERENCES logistics_companies(id) ON DELETE RESTRICT,
  settlement_month TEXT NOT NULL,
  transfer_status TEXT NOT NULL DEFAULT 'pending' CHECK (transfer_status IN ('pending', 'completed')),
  transferred_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (logistics_company_id, settlement_month),
  UNIQUE (id, logistics_company_id),
  CHECK (
    settlement_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND
    substr(settlement_month, 6, 2) BETWEEN '01' AND '12'
  ),
  CHECK (
    (transfer_status = 'pending' AND transferred_at IS NULL) OR
    (transfer_status = 'completed' AND transferred_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS mileage_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  logistics_company_id TEXT NOT NULL REFERENCES logistics_companies(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  receipt_amount INTEGER CHECK (receipt_amount >= 0),
  meter_amount INTEGER CHECK (meter_amount >= 0),
  final_amount INTEGER CHECK (final_amount >= 0),
  -- ponytail: keep the awarded value explicit until the OCR amount and mileage-rate contract agree.
  mileage_amount INTEGER CHECK (mileage_amount >= 0),
  receipt_at TEXT,
  match_status TEXT NOT NULL DEFAULT 'pending' CHECK (match_status IN ('pending', 'matched', 'mismatched', 'ocr_failed', 'duplicate_suspected')),
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  settlement_id TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (settlement_id, logistics_company_id)
    REFERENCES settlements(id, logistics_company_id) ON DELETE RESTRICT,
  CHECK (
    approval_status <> 'approved' OR (
      final_amount IS NOT NULL AND
      mileage_amount IS NOT NULL AND
      decided_at IS NOT NULL
    )
  ),
  CHECK (approval_status = 'pending' OR decided_at IS NOT NULL),
  CHECK (settlement_id IS NULL OR approval_status = 'approved')
) STRICT;

CREATE TABLE IF NOT EXISTS mileage_application_photos (
  id TEXT PRIMARY KEY,
  mileage_application_id TEXT NOT NULL REFERENCES mileage_applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'meter')),
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mileage_application_id, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS phone_verifications (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_up', 'find_email', 'reset_password', 'change_phone')),
  phone TEXT NOT NULL,
  scope_email TEXT COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  proof_hash TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT,
  invalidated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (purpose <> 'reset_password' OR scope_email IS NOT NULL)
) STRICT;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS users_company_idx
  ON users (logistics_company_id, created_at)
  WHERE role = 'driver' AND deactivated_at IS NULL;

CREATE INDEX IF NOT EXISTS installation_sites_bounds_idx
  ON installation_sites (active, latitude, longitude);

CREATE INDEX IF NOT EXISTS installation_site_devices_site_idx
  ON installation_site_devices (installation_site_id, active);

CREATE INDEX IF NOT EXISTS mileage_applications_user_date_idx
  ON mileage_applications (user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS mileage_applications_review_idx
  ON mileage_applications (approval_status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS mileage_applications_settlement_idx
  ON mileage_applications (settlement_id);

CREATE INDEX IF NOT EXISTS phone_verifications_lookup_idx
  ON phone_verifications (purpose, phone, created_at DESC);

CREATE TRIGGER IF NOT EXISTS mileage_applications_driver_company_insert
BEFORE INSERT ON mileage_applications
WHEN NOT EXISTS (
  SELECT 1
  FROM users
  WHERE id = NEW.user_id
    AND role = 'driver'
    AND logistics_company_id = NEW.logistics_company_id
)
BEGIN
  SELECT RAISE(ABORT, 'mileage application requires the driver current company');
END;

CREATE TRIGGER IF NOT EXISTS mileage_applications_ownership_update
BEFORE UPDATE OF user_id, logistics_company_id ON mileage_applications
WHEN NEW.user_id <> OLD.user_id
  OR NEW.logistics_company_id <> OLD.logistics_company_id
BEGIN
  SELECT RAISE(ABORT, 'mileage application ownership cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS mileage_applications_approved_photos_insert
BEFORE INSERT ON mileage_applications
WHEN NEW.approval_status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approved mileage application requires both photos');
END;

CREATE TRIGGER IF NOT EXISTS mileage_applications_approved_photos_update
BEFORE UPDATE OF approval_status ON mileage_applications
WHEN NEW.approval_status = 'approved' AND (
  NOT EXISTS (
    SELECT 1
    FROM mileage_application_photos
    WHERE mileage_application_id = NEW.id AND kind = 'receipt'
  ) OR
  NOT EXISTS (
    SELECT 1
    FROM mileage_application_photos
    WHERE mileage_application_id = NEW.id AND kind = 'meter'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'approved mileage application requires both photos');
END;

CREATE TRIGGER IF NOT EXISTS mileage_application_photos_approved_delete
BEFORE DELETE ON mileage_application_photos
WHEN EXISTS (
  SELECT 1
  FROM mileage_applications
  WHERE id = OLD.mileage_application_id AND approval_status = 'approved'
)
BEGIN
  SELECT RAISE(ABORT, 'approved mileage application photos cannot be removed');
END;

CREATE TRIGGER IF NOT EXISTS mileage_application_photos_approved_update
BEFORE UPDATE ON mileage_application_photos
WHEN EXISTS (
  SELECT 1
  FROM mileage_applications
  WHERE id = OLD.mileage_application_id AND approval_status = 'approved'
)
BEGIN
  SELECT RAISE(ABORT, 'approved mileage application photos cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS settlements_completed_insert
BEFORE INSERT ON settlements
WHEN NEW.transfer_status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'settlement must be created before it is completed');
END;

CREATE TRIGGER IF NOT EXISTS settlements_completed_update
BEFORE UPDATE ON settlements
WHEN OLD.transfer_status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed settlement cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS settlements_complete_without_applications
BEFORE UPDATE OF transfer_status ON settlements
WHEN OLD.transfer_status = 'pending'
  AND NEW.transfer_status = 'completed'
  AND NOT EXISTS (
    SELECT 1
    FROM mileage_applications
    WHERE settlement_id = NEW.id AND approval_status = 'approved'
  )
BEGIN
  SELECT RAISE(ABORT, 'settlement requires an approved mileage application');
END;

CREATE TRIGGER IF NOT EXISTS mileage_applications_completed_settlement_insert
BEFORE INSERT ON mileage_applications
WHEN NEW.settlement_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM settlements
  WHERE id = NEW.settlement_id AND transfer_status = 'completed'
)
BEGIN
  SELECT RAISE(ABORT, 'completed settlement cannot accept applications');
END;

CREATE TRIGGER IF NOT EXISTS mileage_applications_completed_settlement_update
BEFORE UPDATE ON mileage_applications
WHEN (
  OLD.settlement_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM settlements
    WHERE id = OLD.settlement_id AND transfer_status = 'completed'
  )
) OR (
  NEW.settlement_id IS NOT NULL
  AND NEW.settlement_id IS NOT OLD.settlement_id
  AND EXISTS (
    SELECT 1
    FROM settlements
    WHERE id = NEW.settlement_id AND transfer_status = 'completed'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'completed settlement applications cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS mileage_applications_completed_settlement_delete
BEFORE DELETE ON mileage_applications
WHEN OLD.settlement_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM settlements
  WHERE id = OLD.settlement_id AND transfer_status = 'completed'
)
BEGIN
  SELECT RAISE(ABORT, 'completed settlement applications cannot be removed');
END;

PRAGMA user_version = 1;

COMMIT;
