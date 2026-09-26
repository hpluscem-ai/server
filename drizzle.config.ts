import { defineConfig } from 'drizzle-kit';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
});
