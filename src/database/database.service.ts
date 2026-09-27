import { databaseSsl } from './connection-options';
import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

export const DATABASE_URL = 'DATABASE_URL';

@Injectable()
export class DatabaseService implements OnApplicationShutdown, OnModuleInit {
  readonly connection: Sql;
  readonly db: PostgresJsDatabase;

  constructor(
    @Optional()
    @Inject(DATABASE_URL)
    databaseUrl = process.env.DATABASE_URL?.trim(),
  ) {
    if (!databaseUrl) throw new Error('DATABASE_URL is required');

    this.connection = postgres(databaseUrl, {
      ssl: databaseSsl(databaseUrl),
      prepare: false,
      max: process.env.VERCEL ? 1 : 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
    this.db = drizzle({ client: this.connection });
  }

  async onModuleInit() {
    await this.db.execute(sql`select 1`);
  }

  async onApplicationShutdown() {
    await this.connection.end({ timeout: 5 });
  }
}
