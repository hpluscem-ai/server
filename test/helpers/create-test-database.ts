import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { DatabaseService } from '../../src/database/database.service';
import { migrateDatabase } from '../../src/database/migrate';

class TestDatabaseService extends DatabaseService {
  private closed = false;

  constructor(
    databaseUrl: string,
    private readonly adminDatabaseUrl: string,
    private readonly databaseName: string,
  ) {
    super(databaseUrl);
  }

  override async onModuleDestroy() {
    if (this.closed) return;
    this.closed = true;
    await super.onModuleDestroy();

    const admin = postgres(this.adminDatabaseUrl, { prepare: false, max: 1 });
    try {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${this.databaseName}" WITH (FORCE)`,
      );
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
}

export async function createTestDatabase(): Promise<DatabaseService> {
  const adminDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!adminDatabaseUrl)
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests');

  const databaseName = `hpluseco_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(adminDatabaseUrl, { prepare: false, max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const database = new TestDatabaseService(
    databaseUrl.toString(),
    adminDatabaseUrl,
    databaseName,
  );

  try {
    await migrateDatabase(database.connection);
    return database;
  } catch (error) {
    await database.onModuleDestroy();
    throw error;
  }
}
