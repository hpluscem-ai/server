import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURRENT_SCHEMA_VERSION = 9;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly database: DatabaseSync;
  readonly db: NodeSQLiteDatabase;

  constructor() {
    const configuredPath = process.env.DATABASE_PATH?.trim();
    const databasePath =
      configuredPath ||
      (process.env.NODE_ENV === 'test'
        ? ':memory:'
        : join(process.cwd(), 'data', 'hpluseco.sqlite'));

    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    // ponytail: one-process SQLite is enough now; move to Postgres when multi-instance writes are required.
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
    });
    this.db = drizzle({ client: this.database });

    try {
      if (databasePath !== ':memory:') {
        this.database.exec('PRAGMA journal_mode = WAL;');
      }

      const { user_version: schemaVersion } = this.database
        .prepare('PRAGMA user_version')
        .get() as { user_version: number };

      if (schemaVersion > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `Database schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
        );
      }

      if (schemaVersion < CURRENT_SCHEMA_VERSION) {
        if (![0, 1, 2, 3, 4, 5, 6, 7, 8].includes(schemaVersion)) {
          throw new Error(
            `Database schema version ${schemaVersion} requires an explicit migration`,
          );
        }

        if (schemaVersion === 0) {
          const existingObject = this.database
            .prepare(
              `SELECT name
              FROM sqlite_schema
              WHERE name NOT LIKE 'sqlite_%'
                AND type IN ('table', 'view', 'trigger')
              LIMIT 1`,
            )
            .get();

          if (existingObject) {
            throw new Error(
              'Unversioned database is not empty and requires an explicit migration',
            );
          }

          const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
          this.database.exec(schema);
        }

        if (schemaVersion < 2) {
          this.database.exec(
            readFileSync(join(__dirname, '002-auth-sessions.sql'), 'utf8'),
          );
        }
        if (schemaVersion < 3) {
          this.database.exec(
            readFileSync(join(__dirname, '003-admin-sessions.sql'), 'utf8'),
          );
        }
        if (schemaVersion < 4) {
          this.database.exec(
            readFileSync(
              join(__dirname, '004-phone-verification-owner.sql'),
              'utf8',
            ),
          );
        }
        if (schemaVersion < 5) this.migrateDriverWithdrawal();
        if (schemaVersion < 6) {
          this.database.exec(
            readFileSync(join(__dirname, '006-mileage-uploads.sql'), 'utf8'),
          );
        }
        if (schemaVersion < 7)
          this.database.exec(
            readFileSync(
              join(__dirname, '007-station-address-only.sql'),
              'utf8',
            ),
          );
        if (schemaVersion < 8)
          this.database.exec(
            readFileSync(
              join(__dirname, '008-settlement-snapshots.sql'),
              'utf8',
            ),
          );
        if (schemaVersion < 9)
          this.database.exec(
            readFileSync(join(__dirname, '009-mileage-ocr.sql'), 'utf8'),
          );
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get connection() {
    return this.database;
  }

  private migrateDriverWithdrawal() {
    // Rebuild users without cascading deletes or retargeting its existing references.
    this.database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
    try {
      const objects = this.database
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name = 'users' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
        )
        .all() as { sql: string }[];
      this.database.exec(
        readFileSync(join(__dirname, '005-driver-withdrawal.sql'), 'utf8'),
      );
      for (const object of objects) this.database.exec(object.sql);
      if (this.database.prepare('PRAGMA foreign_key_check').all().length) {
        throw new Error(
          'Driver withdrawal migration violates foreign key constraints',
        );
      }
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON;');
    }
  }

  onModuleDestroy() {
    this.database.close();
  }
}
