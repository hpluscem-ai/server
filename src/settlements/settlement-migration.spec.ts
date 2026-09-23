import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from '../database/database.service';

describe('settlement snapshot migration', () => {
  test.each([false, true])(
    'preserve v7 data; migration failure rolls back (failure=%s)',
    (fail) => {
      const directory = mkdtempSync(join(tmpdir(), 'settlement-migration-'));
      const path = join(directory, 'data.sqlite');
      const previous = process.env.DATABASE_PATH;
      let db: DatabaseSync | undefined = new DatabaseSync(path);
      let upgraded: DatabaseService | undefined;
      try {
        for (const name of [
          'schema.sql',
          '002-auth-sessions.sql',
          '003-admin-sessions.sql',
          '004-phone-verification-owner.sql',
        ])
          db.exec(readFileSync(join(__dirname, '../database', name), 'utf8'));
        db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
        db.exec(
          readFileSync(
            join(__dirname, '../database/005-driver-withdrawal.sql'),
            'utf8',
          ),
        );
        db.exec('COMMIT; PRAGMA foreign_keys=ON');
        for (const name of [
          '006-mileage-uploads.sql',
          '007-station-address-only.sql',
        ])
          db.exec(readFileSync(join(__dirname, '../database', name), 'utf8'));
        db.exec(
          "INSERT INTO users(id,role,email,password_hash,name) VALUES('admin','admin','qa@example.test','existing','기존 관리자')",
        );
        const original = db.prepare('SELECT * FROM users').all();
        if (fail)
          db.exec('CREATE TABLE settlement_completions(id TEXT PRIMARY KEY)');
        db.close();
        db = undefined;
        process.env.DATABASE_PATH = path;
        if (fail) {
          expect(() => new DatabaseService()).toThrow();
          db = new DatabaseSync(path);
          expect(db.prepare('PRAGMA user_version').get()).toEqual({
            user_version: 7,
          });
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name='settlement_snapshots'",
              )
              .get(),
          ).toBeUndefined();
        } else {
          upgraded = new DatabaseService();
          upgraded.onModuleDestroy();
          upgraded = new DatabaseService();
          expect(
            upgraded.connection.prepare('PRAGMA user_version').get(),
          ).toEqual({ user_version: 8 });
          expect(
            upgraded.connection
              .prepare('SELECT * FROM settlement_snapshots')
              .all(),
          ).toEqual([]);
        }
        const current = db ?? upgraded!.connection;
        expect(current.prepare('SELECT * FROM users').all()).toEqual(original);
        expect(current.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db?.close();
        upgraded?.onModuleDestroy();
        if (previous === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
