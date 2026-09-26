import { createTestDatabase } from '../../test/helpers/create-test-database';

import { DatabaseService } from './database.service';
import { migrateDatabase } from './migrate';

describe('DatabaseService', () => {
  let database: DatabaseService;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.onModuleDestroy();
  });

  it('creates the PostgreSQL schema and enforces foreign keys', async () => {
    const tables = await database.connection<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'app' and table_name <> '__drizzle_migrations'
      order by table_name
    `;

    expect(tables.map(({ table_name }) => table_name)).toEqual([
      'admin_sessions',
      'auth_sessions',
      'installation_site_devices',
      'installation_sites',
      'logistics_companies',
      'mileage_application_photos',
      'mileage_applications',
      'mileage_ocr_jobs',
      'mileage_resubmissions',
      'mileage_upload_attempts',
      'password_reset_tokens',
      'phone_verifications',
      'settlement_completions',
      'settlement_snapshots',
      'settlements',
      'users',
    ]);

    await expect(
      database.connection.unsafe(
        "insert into app.mileage_applications (id, user_id, logistics_company_id, idempotency_key) values ('application-1', 'missing-user', 'missing-company', 'request-1')",
      ),
    ).rejects.toThrow();
  });

  it('keeps immutable settlement records and approved photos protected', async () => {
    await database.connection.unsafe(`
      insert into app.logistics_companies (
        id, business_name, business_number, corporate_registration_number,
        business_address, manager_name, manager_phone, bank_code, account_number, account_holder
      ) values ('company', '회사', '123', '456', '주소', '담당자', '010', '001', '1234', '예금주');
      insert into app.users (
        id, role, email, password_hash, name, phone, logistics_company_id,
        service_terms_consent, privacy_terms_consent
      ) values ('driver', 'driver', 'driver@example.com', 'hash', '기사', '01012345678', 'company', true, true);
      insert into app.mileage_applications (
        id, user_id, logistics_company_id, idempotency_key, photo_mode,
        final_amount, mileage_amount, approval_status, decided_at
      ) values ('application', 'driver', 'company', 'key', 'separate', 1000, 1000, 'pending', null);
      insert into app.mileage_application_photos (
        id, mileage_application_id, kind, storage_key, content_type, byte_size
      ) values ('photo', 'application', 'receipt', 'receipts/photo', 'image/jpeg', 1);
      insert into app.mileage_application_photos (
        id, mileage_application_id, kind, storage_key, content_type, byte_size
      ) values ('meter-photo', 'application', 'meter', 'meters/photo', 'image/jpeg', 1);
      update app.mileage_applications
      set approval_status = 'approved', decided_at = '2026-09-27T00:00:00.000Z'
      where id = 'application';
    `);

    await expect(
      database.connection.unsafe(
        "delete from app.mileage_application_photos where id = 'photo'",
      ),
    ).rejects.toThrow('approved mileage application photos cannot be changed');
    await expect(
      database.connection.unsafe(
        "update app.mileage_applications set photo_mode = 'single' where id = 'application'",
      ),
    ).rejects.toThrow('approved mileage application photos cannot be changed');

    await database.connection.unsafe(`
      insert into app.settlements (id, logistics_company_id, settlement_month, transfer_status)
      values ('settlement', 'company', '2026-09', 'pending');
      insert into app.settlement_snapshots (
        settlement_id, reference, bank_code, account_number, account_holder, mileage_amount, captured_at, captured_by
      ) values ('settlement', '1234567890', '001', '1234', '예금주', 1000, '2026-09-27T00:00:00.000Z', 'driver');
    `);

    await expect(
      database.connection.unsafe(
        "update app.settlement_snapshots set account_number = 'changed' where settlement_id = 'settlement'",
      ),
    ).rejects.toThrow('settlement_snapshots cannot be changed');

    await database.connection.unsafe(`
      insert into app.settlements (id, logistics_company_id, settlement_month)
      values ('settlement-default', 'company', '2026-10')
    `);
    const [settlement] = await database.connection<
      { transfer_status: string }[]
    >`select transfer_status from app.settlements where id = 'settlement-default'`;
    expect(settlement.transfer_status).toBe('pending');
  });

  it('requires DATABASE_URL when constructed without an explicit test URL', () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new DatabaseService()).toThrow('DATABASE_URL is required');
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('requires verified TLS for remote databases and keeps loopback development local', async () => {
    const remote = new DatabaseService(
      'postgresql://test:test@db.example.invalid/postgres',
    );
    try {
      // postgres-js true uses Node TLS certificate and hostname verification.
      expect(remote.connection.options.ssl).toBe(true);
      expect(database.connection.options.ssl).toBe(false);
      expect(remote.connection.options.prepare).toBe(false);
    } finally {
      await remote.onModuleDestroy();
    }
  });

  it('does not reapply migrations or erase data on a second run', async () => {
    await database.connection`
      insert into app.users (id, role, email, password_hash, name)
      values ('preserved-admin', 'admin', 'preserved@example.com', 'hash', '관리자')
    `;
    await migrateDatabase(database.connection);
    const rows = await database.connection`
      select id from app.users where id = 'preserved-admin'
    `;
    expect(rows).toEqual([{ id: 'preserved-admin' }]);
    const migrations = await database.connection`
      select id from app.__drizzle_migrations
    `;
    expect(migrations).toHaveLength(1);
  });

  it('rejects the Supabase transaction pooler that cannot preserve query pipelining', () => {
    expect(
      () =>
        new DatabaseService(
          'postgresql://postgres.project:test@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
        ),
    ).toThrow('Session pooler URL (port 5432)');
  });

  it('verifies Supabase TLS and caps each Vercel instance at one connection', async () => {
    const previous = process.env.VERCEL;
    process.env.VERCEL = '1';
    const remote = new DatabaseService(
      'postgresql://postgres.project:test@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
    );
    try {
      expect(remote.connection.options.ssl).toMatchObject({
        rejectUnauthorized: true,
        ca: expect.stringContaining('-----BEGIN CERTIFICATE-----') as string,
      });
      expect(remote.connection.options.max).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previous;
      await remote.onModuleDestroy();
    }
  });
});
