import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
  let databaseService: DatabaseService;

  beforeEach(() => {
    process.env.DATABASE_PATH = ':memory:';
    databaseService = new DatabaseService();
  });

  afterEach(() => {
    databaseService.onModuleDestroy();
    delete process.env.DATABASE_PATH;
  });

  it('creates the shared schema and enforces foreign keys', () => {
    const tables = databaseService.connection
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[];

    expect(tables.map(({ name }) => name)).toEqual([
      'installation_site_devices',
      'installation_sites',
      'logistics_companies',
      'mileage_application_photos',
      'mileage_applications',
      'password_reset_tokens',
      'phone_verifications',
      'settlements',
      'users',
    ]);

    expect(
      databaseService.connection.prepare('PRAGMA user_version').get(),
    ).toEqual({ user_version: 1 });

    expect(() => {
      databaseService.connection
        .prepare(
          'INSERT INTO mileage_applications (id, user_id, logistics_company_id, idempotency_key) VALUES (?, ?, ?, ?)',
        )
        .run('application-1', 'missing-user', 'missing-company', 'request-1');
    }).toThrow();
  });

  it('keeps applications inside their driver company and requires both photos before approval', () => {
    const connection = databaseService.connection;

    connection
      .prepare(
        `INSERT INTO logistics_companies (
          id, business_name, business_number, corporate_registration_number,
          business_address, manager_name, manager_phone, bank_code,
          account_number, account_holder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'company-1',
        '테스트 물류',
        '111-11-11111',
        '110111-1111111',
        '서울시 강남구',
        '담당자',
        '010-1111-1111',
        '004',
        '111-111-111111',
        '테스트 물류',
      );
    connection
      .prepare(
        `INSERT INTO logistics_companies (
          id, business_name, business_number, corporate_registration_number,
          business_address, manager_name, manager_phone, bank_code,
          account_number, account_holder
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'company-2',
        '다른 물류',
        '222-22-22222',
        '220222-2222222',
        '서울시 서초구',
        '다른 담당자',
        '010-2222-2222',
        '088',
        '222-222-222222',
        '다른 물류',
      );
    const insertDriver = connection.prepare(
      `INSERT INTO users (
        id, role, email, password_hash, name, phone, logistics_company_id,
        service_terms_consent, privacy_terms_consent
      ) VALUES (?, 'driver', ?, ?, ?, ?, ?, ?, ?)`,
    );

    expect(() =>
      insertDriver.run(
        'driver-without-service-terms',
        'no-service-terms@example.com',
        'password-hash',
        '서비스 미동의',
        '010-3000-0001',
        'company-1',
        0,
        1,
      ),
    ).toThrow();
    expect(() =>
      insertDriver.run(
        'driver-without-privacy-terms',
        'no-privacy-terms@example.com',
        'password-hash',
        '개인정보 미동의',
        '010-3000-0002',
        'company-1',
        1,
        0,
      ),
    ).toThrow();

    insertDriver.run(
      'driver-1',
      'driver@example.com',
      'password-hash',
      '홍길동',
      '010-3333-3333',
      'company-1',
      1,
      1,
    );

    expect(
      connection
        .prepare(
          `SELECT
            service_terms_consent AS serviceTermsConsent,
            privacy_terms_consent AS privacyTermsConsent,
            marketing_consent AS marketingConsent
          FROM users
          WHERE id = ?`,
        )
        .get('driver-1'),
    ).toEqual({
      serviceTermsConsent: 1,
      privacyTermsConsent: 1,
      marketingConsent: 0,
    });

    expect(() => {
      connection
        .prepare(
          `INSERT INTO mileage_applications (
            id, user_id, logistics_company_id, idempotency_key
          ) VALUES (?, ?, ?, ?)`,
        )
        .run('wrong-company', 'driver-1', 'company-2', 'request-1');
    }).toThrow('mileage application requires the driver current company');

    connection
      .prepare(
        `INSERT INTO mileage_applications (
          id, user_id, logistics_company_id, idempotency_key
        ) VALUES (?, ?, ?, ?)`,
      )
      .run('application-1', 'driver-1', 'company-1', 'request-2');

    expect(() => {
      connection
        .prepare(
          `UPDATE mileage_applications
          SET approval_status = 'approved', final_amount = 1000,
              mileage_amount = 200, decided_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        )
        .run('application-1');
    }).toThrow('approved mileage application requires both photos');

    const insertPhoto = connection.prepare(
      `INSERT INTO mileage_application_photos (
        id, mileage_application_id, kind, storage_key, content_type, byte_size
      ) VALUES (?, ?, ?, ?, 'image/jpeg', 1024)`,
    );
    insertPhoto.run(
      'photo-1',
      'application-1',
      'receipt',
      'applications/application-1/receipt.jpg',
    );
    insertPhoto.run(
      'photo-2',
      'application-1',
      'meter',
      'applications/application-1/meter.jpg',
    );

    expect(
      connection
        .prepare(
          `UPDATE mileage_applications
          SET approval_status = 'approved', final_amount = 1000,
              mileage_amount = 200, decided_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        )
        .run('application-1').changes,
    ).toBe(1);

    connection
      .prepare(
        `INSERT INTO settlements (
          id, logistics_company_id, settlement_month
        ) VALUES (?, ?, ?)`,
      )
      .run('other-settlement', 'company-2', '2026-09');

    expect(() => {
      connection
        .prepare(
          'UPDATE mileage_applications SET settlement_id = ? WHERE id = ?',
        )
        .run('other-settlement', 'application-1');
    }).toThrow();

    connection
      .prepare('UPDATE users SET logistics_company_id = ? WHERE id = ?')
      .run('company-2', 'driver-1');

    expect(() => {
      connection
        .prepare(
          'UPDATE mileage_applications SET logistics_company_id = ? WHERE id = ?',
        )
        .run('company-2', 'application-1');
    }).toThrow('mileage application ownership cannot be changed');

    connection
      .prepare(
        `INSERT INTO settlements (
          id, logistics_company_id, settlement_month
        ) VALUES (?, ?, ?)`,
      )
      .run('settlement-1', 'company-1', '2026-09');
    connection
      .prepare('UPDATE mileage_applications SET settlement_id = ? WHERE id = ?')
      .run('settlement-1', 'application-1');
    connection
      .prepare(
        `UPDATE settlements
        SET transfer_status = 'completed', transferred_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      )
      .run('settlement-1');

    expect(() => {
      connection
        .prepare(
          'UPDATE mileage_applications SET mileage_amount = ? WHERE id = ?',
        )
        .run(300, 'application-1');
    }).toThrow('completed settlement applications cannot be changed');
  });

  it('refuses a database created by a newer server schema', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'hpluseco-database-test-'),
    );
    const databasePath = join(temporaryDirectory, 'newer.sqlite');
    const newerDatabase = new DatabaseSync(databasePath);
    const unversionedDatabasePath = join(
      temporaryDirectory,
      'unversioned.sqlite',
    );

    newerDatabase.exec('PRAGMA user_version = 2;');
    newerDatabase.close();
    process.env.DATABASE_PATH = databasePath;

    try {
      expect(() => new DatabaseService()).toThrow(
        'Database schema version 2 is newer than supported version 1',
      );

      const unversionedDatabase = new DatabaseSync(unversionedDatabasePath);
      unversionedDatabase.exec(
        'CREATE TABLE legacy_data (id TEXT PRIMARY KEY)',
      );
      unversionedDatabase.close();
      process.env.DATABASE_PATH = unversionedDatabasePath;

      expect(() => new DatabaseService()).toThrow(
        'Unversioned database is not empty and requires an explicit migration',
      );
    } finally {
      process.env.DATABASE_PATH = ':memory:';
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
