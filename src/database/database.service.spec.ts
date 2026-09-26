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

    expect(
      databaseService.connection.prepare('PRAGMA user_version').get(),
    ).toEqual({ user_version: 11 });

    expect(() => {
      databaseService.connection
        .prepare(
          'INSERT INTO mileage_applications (id, user_id, logistics_company_id, idempotency_key) VALUES (?, ?, ?, ?)',
        )
        .run('application-1', 'missing-user', 'missing-company', 'request-1');
    }).toThrow();
  });

  it('upgrades an existing v8 database without changing its records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hpluseco-v8-ocr-'));
    const path = join(directory, 'v8.sqlite');
    let upgraded: DatabaseService | undefined;
    try {
      process.env.DATABASE_PATH = path;
      const created = new DatabaseService();
      created.connection.exec(
        "INSERT INTO users (id, role, email, password_hash, name) VALUES ('existing-admin', 'admin', 'admin@example.com', 'hash', '관리자')",
      );
      created.onModuleDestroy();
      const old = new DatabaseSync(path);
      old.exec(
        `DROP TRIGGER mileage_applications_approved_photos_update; DROP TRIGGER mileage_applications_approved_mode_update; ALTER TABLE mileage_applications DROP COLUMN photo_mode; CREATE TRIGGER mileage_applications_approved_photos_update BEFORE UPDATE OF approval_status ON mileage_applications WHEN NEW.approval_status = 'approved' AND (NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'receipt') OR NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'meter')) BEGIN SELECT RAISE(ABORT, 'approved mileage application requires both photos'); END;`,
      );
      old.exec(
        'DROP TABLE mileage_resubmissions; DROP TABLE mileage_ocr_jobs; PRAGMA user_version = 8;',
      );
      old.close();
      upgraded = new DatabaseService();
      expect(upgraded.connection.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 11,
      });
      expect(
        upgraded.connection
          .prepare("SELECT name FROM users WHERE id = 'existing-admin'")
          .get(),
      ).toEqual({ name: '관리자' });
      expect(
        upgraded.connection
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'mileage_ocr_jobs'",
          )
          .get(),
      ).toEqual({ name: 'mileage_ocr_jobs' });
      expect(
        upgraded.connection.prepare('PRAGMA foreign_key_check').all(),
      ).toEqual([]);
    } finally {
      upgraded?.onModuleDestroy();
      process.env.DATABASE_PATH = ':memory:';
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'upgrades v9 upload attempts atomically (failure: %s)',
    (fail) => {
      const directory = mkdtempSync(join(tmpdir(), 'hpluseco-resubmit-'));
      const path = join(directory, 'v9.sqlite');
      let checked: DatabaseService | undefined;
      let old: DatabaseSync | undefined;
      try {
        process.env.DATABASE_PATH = path;
        const created = new DatabaseService();
        created.onModuleDestroy();
        old = new DatabaseSync(path);
        old.exec(
          `DROP TRIGGER mileage_applications_approved_photos_update; DROP TRIGGER mileage_applications_approved_mode_update; ALTER TABLE mileage_applications DROP COLUMN photo_mode; DROP INDEX mileage_ocr_jobs_luna_retry_reservation_idx; ALTER TABLE mileage_ocr_jobs DROP COLUMN luna_retry_reserved_at; CREATE TRIGGER mileage_applications_approved_photos_update BEFORE UPDATE OF approval_status ON mileage_applications WHEN NEW.approval_status = 'approved' AND (NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'receipt') OR NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'meter')) BEGIN SELECT RAISE(ABORT, 'approved mileage application requires both photos'); END;`,
        );
        old.exec(`DROP TABLE mileage_resubmissions; DROP TABLE mileage_upload_attempts;
        CREATE TABLE mileage_upload_attempts (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          storage_keys TEXT NOT NULL CHECK (json_valid(storage_keys) AND json_array_length(storage_keys) = 4),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) STRICT;
        INSERT INTO users (id, role, email, password_hash, name) VALUES ('owner', 'admin', 'test@example.com', 'hash', 'test');
        INSERT INTO mileage_upload_attempts (id, user_id, storage_keys) VALUES ('old', 'owner', '["a","b","c","d"]');
        PRAGMA user_version = 9;`);
        const previous = old
          .prepare('SELECT * FROM mileage_upload_attempts')
          .get();
        if (fail)
          old.exec('CREATE TABLE mileage_upload_attempts_new (id TEXT)');
        old.close();
        old = undefined;
        if (fail) {
          expect(() => new DatabaseService()).toThrow('already exists');
          old = new DatabaseSync(path);
          expect(old.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 9,
          });
          expect(
            old
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'mileage_resubmissions'",
              )
              .get(),
          ).toBeUndefined();
          expect(
            old.prepare('SELECT * FROM mileage_upload_attempts').get(),
          ).toEqual(previous);
        } else {
          checked = new DatabaseService();
          const connection = checked.connection;
          expect(
            connection.prepare('SELECT * FROM mileage_upload_attempts').get(),
          ).toEqual(previous);
          connection
            .prepare(
              'INSERT INTO mileage_upload_attempts (id, user_id, storage_keys) VALUES (?, ?, ?)',
            )
            .run('new', 'owner', '["e","f"]');
          expect(() =>
            connection
              .prepare(
                'INSERT INTO mileage_upload_attempts (id, user_id, storage_keys) VALUES (?, ?, ?)',
              )
              .run('invalid', 'owner', '["g"]'),
          ).toThrow();
          expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual(
            [],
          );
          expect(connection.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 11,
          });
        }
      } finally {
        old?.close();
        checked?.onModuleDestroy();
        process.env.DATABASE_PATH = ':memory:';
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'migrates v5 once and rolls back a failed v6 upgrade (failure: %s)',
    (fail) => {
      const directory = mkdtempSync(join(tmpdir(), 'hpluseco-v6-test-'));
      const path = join(directory, 'v5.sqlite');
      let connection: DatabaseSync | undefined = new DatabaseSync(path);
      let upgraded: DatabaseService | undefined;
      try {
        for (const file of [
          'schema.sql',
          '002-auth-sessions.sql',
          '003-admin-sessions.sql',
          '004-phone-verification-owner.sql',
        ])
          connection.exec(readFileSync(join(__dirname, file), 'utf8'));
        connection.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
        connection.exec(
          readFileSync(join(__dirname, '005-driver-withdrawal.sql'), 'utf8'),
        );
        connection.exec('COMMIT; PRAGMA foreign_keys = ON;');
        connection.exec(
          "INSERT INTO users (id, role, email, password_hash, name) VALUES ('v5-admin', 'admin', 'v5@example.com', 'existing-hash', '기존 관리자');",
        );
        const original = connection.prepare('SELECT * FROM users').all();
        if (fail)
          connection.exec(
            'CREATE TABLE mileage_upload_attempts (id TEXT PRIMARY KEY)',
          );
        connection.close();
        connection = undefined;
        process.env.DATABASE_PATH = path;
        if (fail) {
          expect(() => new DatabaseService()).toThrow('already exists');
          connection = new DatabaseSync(path);
          expect(connection.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 5,
          });
          const columns = connection
            .prepare('PRAGMA table_info(mileage_applications)')
            .all();
          expect(columns.some((column) => column.name === 'request_hash')).toBe(
            false,
          );
        } else {
          upgraded = new DatabaseService();
          upgraded.onModuleDestroy();
          upgraded = new DatabaseService();
          expect(
            upgraded.connection.prepare('PRAGMA user_version').get(),
          ).toEqual({ user_version: 11 });
        }
        const checked = upgraded?.connection ?? connection!;
        expect(checked.prepare('SELECT * FROM users').all()).toEqual(original);
        expect(checked.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        connection?.close();
        upgraded?.onModuleDestroy();
        process.env.DATABASE_PATH = ':memory:';
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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
    }).toThrow('approved mileage application requires selected photos');

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

  it('upgrades version 1 while preserving rows and unrelated schema', () => {
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
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name NOT IN ('users', 'installation_sites') AND name NOT IN ('mileage_applications_approved_photos_update', 'mileage_applications_approved_mode_update') AND NOT (type = 'table' AND name IN ('phone_verifications', 'mileage_applications', 'mileage_application_photos')) AND tbl_name <> 'mileage_upload_attempts' AND name <> 'mileage_photos_original_key_idx' ORDER BY name",
        )
        .all();
      const tables = [
        'logistics_companies',
        'users',
        'mileage_applications',
        'phone_verifications',
      ];
      const originalRows = tables.map((table) =>
        connection!
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) =>
            table === 'phone_verifications'
              ? { ...row, scope_user_id: null }
              : table === 'mileage_applications'
                ? { ...row, request_hash: null, photo_mode: 'separate' }
                : row,
          ),
      );
      connection.close();
      connection = undefined;
      process.env.DATABASE_PATH = databasePath;

      upgraded = new DatabaseService();
      expect(upgraded.connection.prepare('PRAGMA user_version').get()).toEqual({
        user_version: 11,
      });
      expect(
        upgraded.connection
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name NOT IN ('users', 'installation_sites', 'auth_sessions', 'admin_sessions', 'settlement_snapshots', 'settlement_completions', 'mileage_ocr_jobs', 'mileage_resubmissions') AND name NOT GLOB 'settlement_capture_*' AND name <> 'mileage_approved_decided_idx' AND name NOT IN ('mileage_applications_approved_photos_update', 'mileage_applications_approved_mode_update') AND NOT (type = 'table' AND name IN ('phone_verifications', 'mileage_applications', 'mileage_application_photos')) AND tbl_name <> 'mileage_upload_attempts' AND name <> 'mileage_photos_original_key_idx' ORDER BY name",
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

  it.each([false, true])(
    'preserves v2 data during admin session migration (failure: %s)',
    (fail) => {
      const directory = mkdtempSync(
        join(tmpdir(), 'hpluseco-admin-migration-'),
      );
      const path = join(directory, 'version-2.sqlite');
      let connection: DatabaseSync | undefined = new DatabaseSync(path);
      let upgraded: DatabaseService | undefined;
      try {
        connection.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
        connection.exec(
          readFileSync(join(__dirname, '002-auth-sessions.sql'), 'utf8'),
        );
        connection.exec(
          "INSERT INTO users (id, role, email, password_hash, name) VALUES ('existing', 'admin', 'existing@example.com', 'existing-hash', '관리자');",
        );
        connection
          .prepare(
            'INSERT INTO auth_sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('a'.repeat(64), 'existing', 1000, 1000, 2000);
        if (fail)
          connection.exec(
            'CREATE INDEX admin_sessions_user_idx ON users (name)',
          );
        const originalUsers = connection.prepare('SELECT * FROM users').all();
        const originalSessions = connection
          .prepare('SELECT * FROM auth_sessions')
          .all();
        connection.close();
        connection = undefined;
        process.env.DATABASE_PATH = path;
        if (fail) {
          expect(() => new DatabaseService()).toThrow(
            'index admin_sessions_user_idx already exists',
          );
          connection = new DatabaseSync(path);
          expect(connection.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 2,
          });
          expect(
            connection
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'admin_sessions'",
              )
              .get(),
          ).toBeUndefined();
        } else {
          upgraded = new DatabaseService();
          expect(
            upgraded.connection.prepare('PRAGMA user_version').get(),
          ).toEqual({ user_version: 11 });
        }
        const checked = upgraded?.connection ?? connection!;
        expect(checked.prepare('SELECT * FROM users').all()).toEqual(
          originalUsers,
        );
        expect(checked.prepare('SELECT * FROM auth_sessions').all()).toEqual(
          originalSessions,
        );
        expect(checked.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        connection?.close();
        upgraded?.onModuleDestroy();
        process.env.DATABASE_PATH = ':memory:';
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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

    newerDatabase.exec('PRAGMA user_version = 12;');
    newerDatabase.close();
    process.env.DATABASE_PATH = databasePath;

    try {
      expect(() => new DatabaseService()).toThrow(
        'Database schema version 12 is newer than supported version 11',
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

  it.each([false, true])(
    'preserves v4 data and references when rebuilding users (failure: %s)',
    (fail) => {
      const directory = mkdtempSync(
        join(tmpdir(), 'hpluseco-withdrawal-migration-'),
      );
      const path = join(directory, 'version-4.sqlite');
      let connection: DatabaseSync | undefined = new DatabaseSync(path);
      let upgraded: DatabaseService | undefined;
      try {
        for (const file of [
          'schema.sql',
          '002-auth-sessions.sql',
          '003-admin-sessions.sql',
          '004-phone-verification-owner.sql',
        ])
          connection.exec(readFileSync(join(__dirname, file), 'utf8'));
        connection.exec(`
        INSERT INTO logistics_companies (id, business_name, business_number, corporate_registration_number,
          business_address, manager_name, manager_phone, bank_code, account_number, account_holder)
        VALUES ('company', '기존 물류', '123', '456', '서울시', '담당자', '010-0000-0000', '19', '1234', '물류');
        INSERT INTO users (id, role, email, password_hash, name, phone, logistics_company_id, service_terms_consent, privacy_terms_consent)
        VALUES ('driver', 'driver', 'Existing@Example.com', 'existing-hash', '기존 기사', '010-1234-5678', 'company', 1, 1);
        INSERT INTO users (id, role, email, password_hash, name)
        VALUES ('admin', 'admin', 'admin@example.com', 'admin-hash', '관리자');
        INSERT INTO settlements (id, logistics_company_id, settlement_month) VALUES ('settlement', 'company', '2026-08');
        INSERT INTO mileage_applications (id, user_id, logistics_company_id, idempotency_key)
        VALUES ('application', 'driver', 'company', 'request');
        INSERT INTO mileage_application_photos (id, mileage_application_id, kind, storage_key, content_type, byte_size)
        VALUES ('receipt', 'application', 'receipt', 'receipt-key', 'image/jpeg', 100),
          ('meter', 'application', 'meter', 'meter-key', 'image/jpeg', 100);
        UPDATE mileage_applications SET approval_status = 'approved', final_amount = 1000, mileage_amount = 20,
          decided_at = CURRENT_TIMESTAMP, settlement_id = 'settlement' WHERE id = 'application';
        UPDATE settlements SET transfer_status = 'completed', transferred_at = CURRENT_TIMESTAMP WHERE id = 'settlement';
        INSERT INTO phone_verifications (id, purpose, phone, code_hash, expires_at, scope_user_id)
        VALUES ('proof', 'change_phone', '010-1111-2222', 'code-hash', '2099-01-01', 'driver');
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
        VALUES ('reset', 'driver', 'reset-hash', '2099-01-01');
        CREATE INDEX custom_users_name_idx ON users (name);
      `);
        connection
          .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?)')
          .run('a'.repeat(64), 'driver', 1000, 1000, 2000);
        connection
          .prepare('INSERT INTO admin_sessions VALUES (?, ?, ?, ?)')
          .run('b'.repeat(64), 'admin', 1000, 2000);
        if (fail)
          connection.exec(
            'CREATE INDEX users_registered_email_idx ON logistics_companies (business_name)',
          );
        const tables = (
          connection
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name);
        const original = tables.map((table) =>
          connection!
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((row) =>
              fail
                ? row
                : table === 'mileage_applications'
                  ? { ...row, request_hash: null, photo_mode: 'separate' }
                  : table === 'mileage_application_photos'
                    ? {
                        ...row,
                        original_storage_key: null,
                        original_content_type: null,
                        original_byte_size: null,
                      }
                    : row,
            ),
        );
        connection.close();
        connection = undefined;
        process.env.DATABASE_PATH = path;
        if (fail) {
          expect(() => new DatabaseService()).toThrow(
            'index users_registered_email_idx already exists',
          );
          connection = new DatabaseSync(path);
          expect(connection.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 4,
          });
        } else {
          upgraded = new DatabaseService();
          expect(
            upgraded.connection.prepare('PRAGMA user_version').get(),
          ).toEqual({ user_version: 11 });
          expect(
            upgraded.connection.prepare('PRAGMA foreign_keys').get(),
          ).toEqual({ foreign_keys: 1 });
          expect(() =>
            upgraded!.connection.exec(
              "UPDATE mileage_applications SET user_id = 'admin' WHERE id = 'application'",
            ),
          ).toThrow();
          upgraded.onModuleDestroy();
          upgraded = new DatabaseService();
        }
        const checked = upgraded?.connection ?? connection!;
        expect(
          tables.map((table) =>
            checked.prepare(`SELECT * FROM ${table}`).all(),
          ),
        ).toEqual(original);
        expect(checked.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(
          checked
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name = 'custom_users_name_idx'",
            )
            .get(),
        ).toBeDefined();
        expect(
          checked
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'users_v5'")
            .get(),
        ).toBeUndefined();
      } finally {
        connection?.close();
        upgraded?.onModuleDestroy();
        process.env.DATABASE_PATH = ':memory:';
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'preserves v3 verification rows during owner migration (failure: %s)',
    (fail) => {
      const directory = mkdtempSync(join(tmpdir(), 'hpluseco-phone-owner-'));
      const path = join(directory, 'version-3.sqlite');
      let connection: DatabaseSync | undefined = new DatabaseSync(path);
      let upgraded: DatabaseService | undefined;
      try {
        for (const file of [
          'schema.sql',
          '002-auth-sessions.sql',
          '003-admin-sessions.sql',
        ])
          connection.exec(readFileSync(join(__dirname, file), 'utf8'));
        connection.exec(
          "INSERT INTO phone_verifications (id, purpose, phone, code_hash, expires_at) VALUES ('legacy-proof', 'sign_up', '010-1234-5678', 'old-code-hash', '2026-09-08 00:00:00');",
        );
        if (fail)
          connection.exec(
            'ALTER TABLE phone_verifications ADD COLUMN scope_user_id TEXT',
          );
        connection.close();
        connection = undefined;
        process.env.DATABASE_PATH = path;
        if (fail) {
          expect(() => new DatabaseService()).toThrow(
            'duplicate column name: scope_user_id',
          );
          connection = new DatabaseSync(path);
          expect(connection.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 3,
          });
        } else {
          upgraded = new DatabaseService();
          expect(
            upgraded.connection.prepare('PRAGMA user_version').get(),
          ).toEqual({ user_version: 11 });
          expect(() =>
            upgraded!.connection.exec(
              "UPDATE phone_verifications SET scope_user_id = 'missing-user'",
            ),
          ).toThrow();
          upgraded.onModuleDestroy();
          upgraded = new DatabaseService();
        }
        const checked = upgraded?.connection ?? connection!;
        expect(
          checked
            .prepare(
              'SELECT id, purpose, phone, code_hash, scope_user_id FROM phone_verifications',
            )
            .all(),
        ).toEqual([
          {
            id: 'legacy-proof',
            purpose: 'sign_up',
            phone: '010-1234-5678',
            code_hash: 'old-code-hash',
            scope_user_id: null,
          },
        ]);
        expect(checked.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        connection?.close();
        upgraded?.onModuleDestroy();
        process.env.DATABASE_PATH = ':memory:';
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
