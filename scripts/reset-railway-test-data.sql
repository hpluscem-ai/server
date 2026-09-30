BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF (SELECT array_agg(tablename::text ORDER BY tablename)
      FROM pg_tables WHERE schemaname = 'app') IS DISTINCT FROM ARRAY[
    '__drizzle_migrations', 'admin_sessions', 'auth_sessions',
    'installation_site_devices', 'installation_sites', 'logistics_companies',
    'mileage_application_photos', 'mileage_applications', 'mileage_ocr_jobs',
    'mileage_resubmissions', 'mileage_upload_attempts', 'password_reset_tokens',
    'phone_verifications', 'settlement_completions', 'settlement_snapshots',
    'settlements', 'users'
  ] THEN
    RAISE EXCEPTION 'app tables changed; review the reset list first';
  END IF;
END $$;

SELECT table_name, row_count FROM (
  SELECT 1 AS position, 'users' AS table_name, count(*) AS row_count FROM app.users
  UNION ALL SELECT 2, 'logistics_companies', count(*) FROM app.logistics_companies
  UNION ALL SELECT 3, 'auth_sessions', count(*) FROM app.auth_sessions
  UNION ALL SELECT 4, 'admin_sessions', count(*) FROM app.admin_sessions
  UNION ALL SELECT 5, 'installation_sites', count(*) FROM app.installation_sites
  UNION ALL SELECT 6, 'installation_site_devices', count(*) FROM app.installation_site_devices
  UNION ALL SELECT 7, 'mileage_applications', count(*) FROM app.mileage_applications
  UNION ALL SELECT 8, 'mileage_application_photos', count(*) FROM app.mileage_application_photos
  UNION ALL SELECT 9, 'mileage_ocr_jobs', count(*) FROM app.mileage_ocr_jobs
  UNION ALL SELECT 10, 'mileage_resubmissions', count(*) FROM app.mileage_resubmissions
  UNION ALL SELECT 11, 'mileage_upload_attempts', count(*) FROM app.mileage_upload_attempts
  UNION ALL SELECT 12, 'settlements', count(*) FROM app.settlements
  UNION ALL SELECT 13, 'settlement_snapshots', count(*) FROM app.settlement_snapshots
  UNION ALL SELECT 14, 'settlement_completions', count(*) FROM app.settlement_completions
  UNION ALL SELECT 15, 'phone_verifications', count(*) FROM app.phone_verifications
  UNION ALL SELECT 16, 'password_reset_tokens', count(*) FROM app.password_reset_tokens
) AS counts ORDER BY position;

\if :apply
TRUNCATE TABLE
  app.mileage_application_photos,
  app.mileage_ocr_jobs,
  app.mileage_resubmissions,
  app.mileage_upload_attempts,
  app.mileage_applications,
  app.settlement_completions,
  app.settlement_snapshots,
  app.settlements,
  app.phone_verifications,
  app.password_reset_tokens
RESTART IDENTITY RESTRICT;

SELECT table_name, row_count FROM (
  SELECT 'mileage_applications' AS table_name, count(*) AS row_count FROM app.mileage_applications
  UNION ALL SELECT 'mileage_application_photos', count(*) FROM app.mileage_application_photos
  UNION ALL SELECT 'mileage_ocr_jobs', count(*) FROM app.mileage_ocr_jobs
  UNION ALL SELECT 'mileage_resubmissions', count(*) FROM app.mileage_resubmissions
  UNION ALL SELECT 'mileage_upload_attempts', count(*) FROM app.mileage_upload_attempts
  UNION ALL SELECT 'settlements', count(*) FROM app.settlements
  UNION ALL SELECT 'settlement_snapshots', count(*) FROM app.settlement_snapshots
  UNION ALL SELECT 'settlement_completions', count(*) FROM app.settlement_completions
  UNION ALL SELECT 'phone_verifications', count(*) FROM app.phone_verifications
  UNION ALL SELECT 'password_reset_tokens', count(*) FROM app.password_reset_tokens
) AS counts ORDER BY table_name;
\endif

COMMIT;
