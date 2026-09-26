import { databaseSsl } from './connection-options';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { resolve } from 'node:path';

export async function migrateDatabase(connection: Sql) {
  await migrate(drizzle({ client: connection }), {
    migrationsFolder: resolve(process.cwd(), 'drizzle'),
    migrationsSchema: 'app',
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_MIGRATION_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_MIGRATION_URL is required');

  const connection = postgres(databaseUrl, {
    ssl: databaseSsl(databaseUrl),
    prepare: false,
    max: 1,
  });
  try {
    await migrateDatabase(connection);
  } finally {
    await connection.end({ timeout: 5 });
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Database migration failed');
    process.exitCode = 1;
  });
}
