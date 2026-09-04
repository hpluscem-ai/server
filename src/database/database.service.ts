import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURRENT_SCHEMA_VERSION = 1;

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
        if (schemaVersion !== 0) {
          throw new Error(
            `Database schema version ${schemaVersion} requires an explicit migration`,
          );
        }

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
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  get connection() {
    return this.database;
  }

  onModuleDestroy() {
    this.database.close();
  }
}
