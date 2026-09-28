import { createTestDatabase } from '../../test/helpers/create-test-database';
import {
  verifyDatabaseTransfer,
  verifyDatabaseTransferConnections,
} from '../../scripts/verify-db-transfer';

import { DatabaseService } from './database.service';

describe('verifyDatabaseTransferConnections', () => {
  let source: DatabaseService;
  let target: DatabaseService;

  beforeEach(async () => {
    source = await createTestDatabase();
    target = await createTestDatabase();
    for (const database of [source, target]) {
      await database.connection`
        insert into app.users (
          id, role, email, password_hash, name, created_at, updated_at
        ) values (
          'admin', 'admin', 'admin@example.com', 'hash', '관리자',
          '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'
        )
      `;
    }
    const migrations = await source.connection<
      {
        id: number;
        hash: string;
        name: string | null;
        applied_at: Date;
        created_at: string;
      }[]
    >`
      select id, hash, name, applied_at, created_at
      from app.__drizzle_migrations
      order by id
    `;
    await target.connection.unsafe('delete from app.__drizzle_migrations');
    for (const migration of migrations) {
      await target.connection`
        insert into app.__drizzle_migrations (id, hash, name, applied_at, created_at)
        values (
          ${migration.id}, ${migration.hash}, ${migration.name},
          ${migration.applied_at}, ${migration.created_at}
        )
      `;
    }
  });

  afterEach(async () => {
    await target?.onApplicationShutdown();
    await source?.onApplicationShutdown();
  });

  it('accepts matching app data and schema', async () => {
    await expect(
      verifyDatabaseTransferConnections(source.connection, target.connection),
    ).resolves.toBeUndefined();
  });

  it('rejects changed data when the row count is unchanged', async () => {
    await target.connection`
      update app.users set name = '변경됨' where id = 'admin'
    `;

    await expect(
      verifyDatabaseTransferConnections(source.connection, target.connection),
    ).rejects.toThrow('data fingerprint mismatch: users');
  });

  it('compares NOT NULL through columns', async () => {
    await target.connection.unsafe(
      'alter table app.users alter column name drop not null',
    );

    await expect(
      verifyDatabaseTransferConnections(source.connection, target.connection),
    ).rejects.toThrow('columns mismatch: users.name');
  });

  it('rejects a changed uncalled sequence state', async () => {
    await target.connection.unsafe(
      "select setval('app.mileage_resubmissions_id_seq', 42, false)",
    );

    await expect(
      verifyDatabaseTransferConnections(source.connection, target.connection),
    ).rejects.toThrow('sequence state mismatch: mileage_resubmissions_id_seq');
  });

  it('rejects URLs that point at the same database despite different passwords', async () => {
    await expect(
      verifyDatabaseTransfer(
        'postgresql://source:one@example.invalid:5432/app',
        'postgresql://target:two@example.invalid:5432/app',
      ),
    ).rejects.toThrow(
      'Source and target databases must point to different databases',
    );
  });

  it('rejects a missing app schema', async () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation();
    try {
      await target.connection.unsafe('drop schema app cascade');
    } finally {
      consoleLog.mockRestore();
    }

    await expect(
      verifyDatabaseTransferConnections(source.connection, target.connection),
    ).rejects.toThrow('target: app schema missing');
  });
});
