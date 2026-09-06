import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';

import { DatabaseService } from './database.service';
import { authSessions, users } from './schema';

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
      'auth_sessions',
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
    ).toEqual({ user_version: 2 });

    expect(() => {
      databaseService.connection
        .prepare(
          'INSERT INTO mileage_applications (id, user_id, logistics_company_id, idempotency_key) VALUES (?, ?, ?, ?)',
        )
        .run('application-1', 'missing-user', 'missing-company', 'request-1');
    }).toThrow();
  });

  describe('auth_sessions', () => {
    beforeEach(() => {
      databaseService.db
        .insert(users)
        .values({
          id: 'session-user',
          role: 'admin',
          email: 'session@example.com',
          passwordHash: 'test-password-hash',
          name: '세션 테스트 사용자',
        })
        .run();
    });

    it('round-trips Date values and supports multiple independent sessions per user', () => {
      const db = databaseService.db;
      const session = {
        tokenHash: 'a'.repeat(64),
        userId: 'session-user',
        createdAt: new Date('2026-09-06T00:00:00.123Z'),
        lastUsedAt: new Date('2026-09-06T00:00:00.123Z'),
        expiresAt: new Date('2026-10-06T00:00:00.123Z'),
      };

      db.insert(authSessions).values(session).run();
      expect(db.select().from(authSessions).get()).toEqual(session);
      expect(
        databaseService.connection
          .prepare('SELECT created_at FROM auth_sessions')
          .get(),
      ).toEqual({ created_at: session.createdAt.getTime() });

      db.insert(authSessions)
        .values({ ...session, tokenHash: 'b'.repeat(64) })
        .run();
      expect(db.select().from(authSessions).all()).toHaveLength(2);

      const lastUsedAt = new Date('2026-09-07T01:02:03.456Z');
      db.update(authSessions)
        .set({ lastUsedAt })
        .where(eq(authSessions.tokenHash, session.tokenHash))
        .run();
      expect(
        db
          .select()
          .from(authSessions)
          .where(eq(authSessions.tokenHash, session.tokenHash))
          .get(),
      ).toEqual({ ...session, lastUsedAt });

      db.delete(authSessions)
        .where(eq(authSessions.tokenHash, session.tokenHash))
        .run();
      expect(db.select().from(authSessions).all()).toEqual([
        { ...session, tokenHash: 'b'.repeat(64) },
      ]);

      db.delete(users).where(eq(users.id, session.userId)).run();
      expect(db.select().from(authSessions).all()).toEqual([]);
    });

    it.each([
      ['duplicate hash', 'a'.repeat(64), 'session-user', 1000, 1000, 2000],
      ['missing user', 'b'.repeat(64), 'missing-user', 1000, 1000, 2000],
      ['raw token', 'raw-session-token', 'session-user', 1000, 1000, 2000],
      ['non-hex hash', 'g'.repeat(64), 'session-user', 1000, 1000, 2000],
      ['missing hash', null, 'session-user', 1000, 1000, 2000],
      ['missing expiry', 'b'.repeat(64), 'session-user', 1000, 1000, null],
      ['text date', 'b'.repeat(64), 'session-user', 'not-a-date', 1000, 2000],
      [
        'last use before creation',
        'b'.repeat(64),
        'session-user',
        1000,
        999,
        2000,
      ],
      ['last use at expiry', 'b'.repeat(64), 'session-user', 1000, 2000, 2000],
    ])(
      'rejects %s',
      (_label, tokenHash, userId, createdAt, lastUsedAt, expiresAt) => {
        const insert = databaseService.connection.prepare(`
          INSERT INTO auth_sessions (
            token_hash, user_id, created_at, last_used_at, expires_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        insert.run('a'.repeat(64), 'session-user', 1000, 1000, 2000);

        expect(() =>
          insert.run(tokenHash, userId, createdAt, lastUsedAt, expiresAt),
        ).toThrow();
        expect(
          databaseService.connection
            .prepare('SELECT COUNT(*) AS count FROM auth_sessions')
            .get(),
        ).toEqual({ count: 1 });
      },
    );
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

  it('upgrades a version 1 database without changing existing data or schema', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'hpluseco-session-migration-'),
    );
    const databasePath = join(temporaryDirectory, 'version-1.sqlite');
    let connection: DatabaseSync | undefined = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
    });
    let upgraded: DatabaseService | undefined;

    try {
      connection.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
      connection.exec(`
        INSERT INTO logistics_companies (
          id, business_name, business_number, corporate_registration_number,
          business_address, manager_name, manager_phone, bank_code,
          account_number, account_holder
        ) VALUES (
          'legacy-company', '기존 물류사', '111-11-11111', '110111-1111111',
          '서울', '담당자', '010-1111-1111', '004', '111111', '기존 물류사'
        );
        INSERT INTO users (
          id, role, email, password_hash, name, phone, logistics_company_id,
          service_terms_consent, privacy_terms_consent
        ) VALUES (
          'legacy-driver', 'driver', 'legacy@example.com', 'existing-hash',
          '기존 기사', '010-2222-2222', 'legacy-company', 1, 1
        );
        INSERT INTO mileage_applications (
          id, user_id, logistics_company_id, idempotency_key
        ) VALUES ('legacy-application', 'legacy-driver', 'legacy-company', 'legacy-request');
        INSERT INTO phone_verifications (
          id, purpose, phone, code_hash, expires_at
        ) VALUES (
          'legacy-verification', 'sign_up', '010-3333-3333', 'existing-code-hash',
          '2026-09-06 00:03:00'
        );
      `);

      const originalSchema = connection
        .prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name')
        .all();
      const tables = [
        'logistics_companies',
        'users',
        'mileage_applications',
        'phone_verifications',
      ];
      const originalRows = tables.map((table) =>
        connection!.prepare(`SELECT * FROM ${table}`).all(),
      );
      connection.close();
      connection = undefined;
      process.env.DATABASE_PATH = databasePath;

      upgraded = new DatabaseService();
      expect(upgraded.connection.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 2,
      });
      expect(
        upgraded.connection
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name <> 'auth_sessions' ORDER BY name",
          )
          .all(),
      ).toEqual(originalSchema);
      expect(
        tables.map((table) =>
          upgraded!.connection.prepare(`SELECT * FROM ${table}`).all(),
        ),
      ).toEqual(originalRows);
      expect(
        upgraded.connection.prepare('PRAGMA foreign_key_check').all(),
      ).toEqual([]);

      // A second startup must not reapply the migration or remove sessions.
      upgraded.connection
        .prepare(
          `INSERT INTO auth_sessions (
            token_hash, user_id, created_at, last_used_at, expires_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('a'.repeat(64), 'legacy-driver', 1000, 1000, 2000);
      upgraded.onModuleDestroy();
      upgraded = undefined;
      upgraded = new DatabaseService();
      expect(
        upgraded.connection
          .prepare('SELECT token_hash FROM auth_sessions')
          .all(),
      ).toEqual([{ token_hash: 'a'.repeat(64) }]);
    } finally {
      connection?.close();
      upgraded?.onModuleDestroy();
      process.env.DATABASE_PATH = ':memory:';
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('rolls back a failed migration without advancing the database version', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'hpluseco-session-rollback-'),
    );
    const databasePath = join(temporaryDirectory, 'version-1.sqlite');
    let connection: DatabaseSync | undefined = new DatabaseSync(databasePath);

    try {
      connection.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
      // Force failure after CREATE TABLE, while keeping the v1 data intact.
      connection.exec(`
        CREATE INDEX auth_sessions_user_idx ON users (name);
        INSERT INTO users (id, role, email, password_hash, name)
        VALUES ('existing-user', 'admin', 'admin@example.com', 'existing-hash', '관리자');
      `);
      connection.close();
      connection = undefined;
      process.env.DATABASE_PATH = databasePath;

      expect(() => {
        const unexpectedSuccess = new DatabaseService();
        unexpectedSuccess.onModuleDestroy();
      }).toThrow('index auth_sessions_user_idx already exists');

      connection = new DatabaseSync(databasePath);
      expect(connection.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 1,
      });
      expect(
        connection
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'auth_sessions'",
          )
          .get(),
      ).toBeUndefined();
      expect(connection.prepare('SELECT id, name FROM users').all()).toEqual([
        { id: 'existing-user', name: '관리자' },
      ]);
    } finally {
      connection?.close();
      process.env.DATABASE_PATH = ':memory:';
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
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

    newerDatabase.exec('PRAGMA user_version = 3;');
    newerDatabase.close();
    process.env.DATABASE_PATH = databasePath;

    try {
      expect(() => new DatabaseService()).toThrow(
        'Database schema version 3 is newer than supported version 2',
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
