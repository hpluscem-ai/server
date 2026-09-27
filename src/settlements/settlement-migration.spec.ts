import { randomUUID } from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import { createTestDatabase } from '../../test/helpers/create-test-database';

describe('PostgreSQL settlement schema', () => {
  let database: DatabaseService;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.onApplicationShutdown();
  });

  test('installs the immutable snapshot and completion records with their settlement protections', async () => {
    const db = database.connection;
    const company = randomUUID();
    const admin = randomUUID();
    const driver = randomUUID();
    const application = randomUUID();
    const settlement = randomUUID();
    const now = new Date().toISOString();

    expect(
      await db<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'app'
          AND table_name IN ('settlements', 'settlement_snapshots', 'settlement_completions')
        ORDER BY table_name`,
    ).toEqual([
      { table_name: 'settlement_completions' },
      { table_name: 'settlement_snapshots' },
      { table_name: 'settlements' },
    ]);

    await db`
      INSERT INTO app.logistics_companies(
        id, business_name, business_number, corporate_registration_number,
        business_address, manager_name, manager_phone, bank_code, account_number, account_holder
      ) VALUES (
        ${company}, '테스트 물류', ${company}, ${company}, '서울', '담당자',
        '01012345678', '4', '001234567890', '예금주'
      )`;
    await db`
      INSERT INTO app.users(id, role, email, password_hash, name)
      VALUES (${admin}, 'admin', ${`${admin}@example.test`}, 'hash', '관리자')`;
    await db`
      INSERT INTO app.users(
        id, role, email, password_hash, name, phone, logistics_company_id,
        service_terms_consent, privacy_terms_consent
      ) VALUES (
        ${driver}, 'driver', ${`${driver}@example.test`}, 'hash', '기사',
        '01012345678', ${company}, true, true
      )`;
    await db`
      INSERT INTO app.mileage_applications(
        id, user_id, logistics_company_id, idempotency_key, final_amount,
        mileage_amount
      ) VALUES (
        ${application}, ${driver}, ${company}, ${application}, 200000, 3000
      )`;
    for (const kind of ['receipt', 'meter'])
      await db`
        INSERT INTO app.mileage_application_photos(
          id, mileage_application_id, kind, storage_key, content_type, byte_size
        ) VALUES (${randomUUID()}, ${application}, ${kind}, ${randomUUID()}, 'image/jpeg', 1)`;
    await db`
      UPDATE app.mileage_applications
      SET approval_status = 'approved', decided_at = ${now}
      WHERE id = ${application}`;
    await db`
      INSERT INTO app.settlements(id, logistics_company_id, settlement_month, transfer_status)
      VALUES (${settlement}, ${company}, '2026-08', 'pending')`;
    await db`
      UPDATE app.mileage_applications SET settlement_id = ${settlement}
      WHERE id = ${application}`;
    await db`
      INSERT INTO app.settlement_snapshots(
        settlement_id, reference, bank_code, account_number, account_holder,
        mileage_amount, captured_at, captured_by
      ) VALUES (
        ${settlement}, '1234567890', '4', '001234567890', '예금주', 3000, ${now}, ${admin}
      )`;
    await db`
      INSERT INTO app.settlement_completions(settlement_id, file_hash, completed_by, completed_at)
      VALUES (${settlement}, ${'a'.repeat(64)}, ${admin}, ${now})`;
    await db`
      UPDATE app.settlements
      SET transfer_status = 'completed', transferred_at = ${now}
      WHERE id = ${settlement}`;

    await expect(
      db`UPDATE app.settlement_snapshots SET account_number = '009999'`,
    ).rejects.toThrow(/cannot be changed/i);
    await expect(
      db`UPDATE app.settlements SET settlement_month = '2026-07'`,
    ).rejects.toThrow(/cannot be changed/i);
    await expect(
      db`DELETE FROM app.mileage_applications WHERE id = ${application}`,
    ).rejects.toThrow(/captured/i);
  });
});
