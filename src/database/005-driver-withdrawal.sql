-- DatabaseService owns the transaction and temporarily disables foreign keys.
DROP TRIGGER mileage_applications_driver_company_insert;

CREATE TABLE users_v5 (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  email TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  logistics_company_id TEXT REFERENCES logistics_companies(id) ON DELETE RESTRICT,
  service_terms_consent INTEGER NOT NULL DEFAULT 0 CHECK (service_terms_consent IN (0, 1)),
  privacy_terms_consent INTEGER NOT NULL DEFAULT 0 CHECK (privacy_terms_consent IN (0, 1)),
  marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK (marketing_consent IN (0, 1)),
  deactivated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (role = 'admin' OR (
    phone IS NOT NULL AND logistics_company_id IS NOT NULL AND
    service_terms_consent = 1 AND privacy_terms_consent = 1
  )),
  CHECK (password_hash IS NOT NULL OR (role = 'driver' AND deactivated_at IS NOT NULL))
) STRICT;

INSERT INTO users_v5 SELECT * FROM users;
DROP TABLE users;
ALTER TABLE users_v5 RENAME TO users;

-- Only withdrawn drivers release their email and phone for a new registration.
CREATE UNIQUE INDEX users_registered_email_idx ON users(email)
  WHERE deactivated_at IS NULL OR role = 'admin';
CREATE UNIQUE INDEX users_registered_phone_idx ON users(phone)
  WHERE deactivated_at IS NULL OR role = 'admin';

CREATE TRIGGER mileage_applications_driver_company_insert
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

PRAGMA user_version = 5;
