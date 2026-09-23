BEGIN IMMEDIATE;
-- Apply through the shared database migration owner, inside its migration transaction.
CREATE TABLE settlement_snapshots (
  settlement_id TEXT PRIMARY KEY REFERENCES settlements(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL UNIQUE CHECK (length(reference) = 10 AND reference NOT GLOB '*[^0-9]*'),
  bank_code TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_holder TEXT NOT NULL,
  mileage_amount INTEGER NOT NULL CHECK (mileage_amount BETWEEN 0 AND 9007199254740991),
  captured_at TEXT NOT NULL,
  captured_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE settlement_completions (
  settlement_id TEXT PRIMARY KEY REFERENCES settlement_snapshots(settlement_id) ON DELETE RESTRICT,
  file_hash TEXT NOT NULL CHECK(length(file_hash) = 64),
  completed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  completed_at TEXT NOT NULL
) STRICT;
CREATE INDEX mileage_approved_decided_idx ON mileage_applications(decided_at) WHERE approval_status = 'approved';
CREATE TRIGGER settlement_snapshot_update BEFORE UPDATE ON settlement_snapshots BEGIN
  SELECT RAISE(ABORT, 'settlement snapshot cannot be changed');
END;
CREATE TRIGGER settlement_snapshot_delete BEFORE DELETE ON settlement_snapshots BEGIN
  SELECT RAISE(ABORT, 'settlement snapshot cannot be removed');
END;
CREATE TRIGGER settlement_completion_update BEFORE UPDATE ON settlement_completions BEGIN
  SELECT RAISE(ABORT, 'settlement completion cannot be changed');
END;
CREATE TRIGGER settlement_completion_delete BEFORE DELETE ON settlement_completions BEGIN
  SELECT RAISE(ABORT, 'settlement completion cannot be removed');
END;
CREATE TRIGGER settlement_capture_update BEFORE UPDATE ON mileage_applications
WHEN EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id IN (OLD.settlement_id, NEW.settlement_id)) BEGIN
  SELECT RAISE(ABORT, 'captured settlement applications cannot be changed');
END;
CREATE TRIGGER settlement_capture_insert BEFORE INSERT ON mileage_applications
WHEN EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = NEW.settlement_id) BEGIN
  SELECT RAISE(ABORT, 'captured settlement cannot accept applications');
END;
CREATE TRIGGER settlement_capture_delete BEFORE DELETE ON mileage_applications
WHEN EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = OLD.settlement_id) BEGIN
  SELECT RAISE(ABORT, 'captured settlement applications cannot be removed');
END;
CREATE TRIGGER settlement_capture_identity BEFORE UPDATE OF logistics_company_id, settlement_month, id ON settlements
WHEN EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = OLD.id) BEGIN
  SELECT RAISE(ABORT, 'captured settlement identity cannot be changed');
END;
CREATE TRIGGER settlement_capture_complete BEFORE UPDATE OF transfer_status ON settlements
WHEN NEW.transfer_status = 'completed' AND EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = OLD.id)
AND NOT EXISTS (SELECT 1 FROM settlement_completions WHERE settlement_id = OLD.id AND completed_at = NEW.transferred_at) BEGIN
  SELECT RAISE(ABORT, 'settlement requires an upload completion record');
END;

PRAGMA user_version=8;
COMMIT;
