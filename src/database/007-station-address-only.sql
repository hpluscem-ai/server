BEGIN IMMEDIATE;

ALTER TABLE installation_sites DROP COLUMN area;
ALTER TABLE installation_sites DROP COLUMN site_type;

PRAGMA user_version = 7;

COMMIT;
