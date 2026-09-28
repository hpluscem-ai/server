import { createHash } from 'node:crypto';

import postgres, { type Sql } from 'postgres';

import { databaseSsl } from '../src/database/connection-options';

const APP_SCHEMA = 'app';
const MIGRATIONS_TABLE = '__drizzle_migrations';
const TABLE_KINDS = "'r', 'p'";

type CatalogEntry = Record<string, unknown> & { key: string };

type Snapshot = {
  tables: Map<string, { count: number; fingerprint: string }>;
  checks: Map<string, Map<string, string>>;
};

class VerificationError extends Error {}

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function catalogFingerprint(rows: CatalogEntry[]) {
  return new Map(
    rows.map((row) => [row.key, fingerprint(JSON.stringify(row))]),
  );
}

async function fingerprintTable(connection: Sql, table: string) {
  const rows = connection.unsafe<{ row_json: string }[]>(`
    select to_jsonb(row)::text as row_json
    from ${identifier(APP_SCHEMA)}.${identifier(table)} as row
    order by to_jsonb(row)
  `);
  const hash = createHash('sha256');
  let count = 0;

  for await (const batch of rows.cursor(1000)) {
    for (const { row_json } of batch) {
      hash.update(row_json).update('\n');
      count += 1;
    }
  }

  return { count, fingerprint: hash.digest('hex') };
}

async function inspectDatabase(connection: Sql, side: 'source' | 'target') {
  return connection.begin(async (transaction) => {
    await transaction.unsafe(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    await transaction.unsafe("SET LOCAL TimeZone = 'UTC'");
    // PostgreSQL rejects reads that RLS would filter when this is off.
    await transaction.unsafe('SET LOCAL row_security = off');

    const [schema] = await transaction<{ exists: boolean }[]>`
      select exists(select 1 from pg_namespace where nspname = ${APP_SCHEMA}) as exists
    `;
    if (!schema?.exists)
      throw new VerificationError(`${side}: app schema missing`);

    const tables = await transaction.unsafe<{ table_name: string }[]>(`
      select relname as table_name
      from pg_class
      join pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where nspname = '${APP_SCHEMA}' and relkind in (${TABLE_KINDS})
      order by relname
    `);
    const names = tables.map(({ table_name }) => table_name);
    if (!names.some((name) => name !== MIGRATIONS_TABLE))
      throw new VerificationError(
        `${side}: app schema has no application tables`,
      );
    if (!names.includes(MIGRATIONS_TABLE))
      throw new VerificationError(`${side}: app migration ledger missing`);

    const snapshots = new Map<string, { count: number; fingerprint: string }>();
    for (const table of names) {
      const snapshot = await fingerprintTable(transaction, table);
      if (table === MIGRATIONS_TABLE && snapshot.count === 0)
        throw new VerificationError(`${side}: app migration ledger empty`);
      snapshots.set(table, snapshot);
    }

    const checks = new Map<string, Map<string, string>>();
    for (const [name, query] of Object.entries(catalogQueries)) {
      checks.set(name, catalogFingerprint(await transaction.unsafe(query)));
    }
    checks.set('sequence state', await sequenceStateFingerprint(transaction));

    return { tables: snapshots, checks } satisfies Snapshot;
  });
}

async function sequenceStateFingerprint(connection: Sql) {
  const sequences = await connection.unsafe<{ sequence_name: string }[]>(`
    select c.relname as sequence_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = '${APP_SCHEMA}' and c.relkind = 'S'
    order by c.relname
  `);
  const states = new Map<string, string>();
  for (const { sequence_name } of sequences) {
    const [state] = await connection.unsafe<
      { last_value: string; is_called: boolean }[]
    >(`
      select last_value::text, is_called
      from ${identifier(APP_SCHEMA)}.${identifier(sequence_name)}
    `);
    states.set(sequence_name, fingerprint(JSON.stringify(state)));
  }
  return states;
}

const catalogQueries = {
  columns: `
    select c.relname || '.' || a.attname as key, a.attnum::text, a.attnotnull,
      pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
      coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') as default_expression,
      a.attidentity, a.attgenerated, a.attcollation::regcollation::text as collation
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where n.nspname = 'app' and c.relkind in (${TABLE_KINDS})
      and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `,
  constraints: `
    select c.relname || '.' || con.conname as key, con.contype, con.condeferrable,
      con.condeferred, con.convalidated,
      coalesce(to_jsonb(con)->>'conenforced', 'true')::boolean as enforced,
      pg_get_constraintdef(con.oid, true) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in (${TABLE_KINDS}) and con.contype <> 'n'
    order by c.relname, con.conname
  `,
  indexes: `
    select c.relname || '.' || i.relname as key, x.indisunique, x.indisprimary,
      x.indisvalid, x.indisready, pg_get_indexdef(i.oid) as definition
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in (${TABLE_KINDS})
    order by c.relname, i.relname
  `,
  rls: `
    select 'table.' || c.relname as key,
      jsonb_build_object('row_security', c.relrowsecurity, 'force_row_security', c.relforcerowsecurity)::text as definition
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in (${TABLE_KINDS})
    union all
    select 'policy.' || c.relname || '.' || p.polname as key,
      jsonb_build_object(
        'permissive', p.polpermissive,
        'command', p.polcmd,
        'roles', (
          select coalesce(
            jsonb_agg(coalesce(r.rolname, 'PUBLIC') order by coalesce(r.rolname, 'PUBLIC')),
            '[]'::jsonb
          )
          from unnest(p.polroles) as policy_role(role_oid)
          left join pg_roles r on r.oid = policy_role.role_oid
        ),
        'using', coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
        'check', coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
      )::text as definition
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app'
    order by 1
  `,
  triggers: `
    select c.relname || '.' || t.tgname as key, t.tgtype, t.tgenabled,
      pg_get_triggerdef(t.oid, true) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and not t.tgisinternal
    order by c.relname, t.tgname
  `,
  functions: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
      p.prokind, pg_get_function_result(p.oid) as result, pg_get_function_arguments(p.oid) as arguments,
      p.prosrc, p.probin, p.provolatile, p.proisstrict, p.prosecdef, p.proleakproof,
      coalesce(array_to_string(p.proconfig, E'\\n'), '') as configuration
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
    order by p.proname, pg_get_function_identity_arguments(p.oid)
  `,
  sequences: `
    select c.relname as key, s.seqstart::text, s.seqincrement::text, s.seqmax::text,
      s.seqmin::text, s.seqcache::text, s.seqcycle
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_sequence s on s.seqrelid = c.oid
    where n.nspname = 'app' and c.relkind = 'S'
    order by c.relname
  `,
} as const;

function compareEntries(
  check: string,
  source: Map<string, string>,
  target: Map<string, string>,
) {
  const keys = new Set([...source.keys(), ...target.keys()]);
  for (const key of [...keys].sort()) {
    if (source.get(key) !== target.get(key))
      throw new VerificationError(`${check} mismatch: ${key}`);
  }
}

function compareSnapshots(source: Snapshot, target: Snapshot) {
  compareEntries(
    'table list',
    new Map([...source.tables.keys()].map((name) => [name, name])),
    new Map([...target.tables.keys()].map((name) => [name, name])),
  );

  for (const [table, sourceTable] of source.tables) {
    const targetTable = target.tables.get(table);
    if (!targetTable) continue;
    if (sourceTable.count !== targetTable.count)
      throw new VerificationError(`row count mismatch: ${table}`);
    if (sourceTable.fingerprint !== targetTable.fingerprint)
      throw new VerificationError(`data fingerprint mismatch: ${table}`);
  }

  for (const check of [...Object.keys(catalogQueries), 'sequence state']) {
    compareEntries(
      check,
      source.checks.get(check) ?? new Map<string, string>(),
      target.checks.get(check) ?? new Map<string, string>(),
    );
  }
}

function sameDatabase(sourceUrl: string, targetUrl: string) {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  const database = (url: URL) =>
    decodeURIComponent(url.pathname.slice(1)) ||
    decodeURIComponent(url.username);

  return (
    source.hostname === target.hostname &&
    Number(source.port || 5432) === Number(target.port || 5432) &&
    database(source) === database(target)
  );
}

export async function verifyDatabaseTransferConnections(
  source: Sql,
  target: Sql,
) {
  try {
    compareSnapshots(
      await inspectDatabase(source, 'source'),
      await inspectDatabase(target, 'target'),
    );
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('Database transfer verification failed');
  }
}

export async function verifyDatabaseTransfer(
  sourceUrl: string,
  targetUrl: string,
) {
  let source: Sql | undefined;
  let target: Sql | undefined;
  try {
    if (sameDatabase(sourceUrl, targetUrl))
      throw new VerificationError(
        'Source and target databases must point to different databases',
      );
    source = postgres(sourceUrl, {
      ssl: databaseSsl(sourceUrl),
      prepare: false,
      max: 1,
    });
    target = postgres(targetUrl, {
      ssl: databaseSsl(targetUrl),
      prepare: false,
      max: 1,
    });
    await verifyDatabaseTransferConnections(source, target);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('Database transfer verification failed');
  } finally {
    await Promise.all([
      source?.end({ timeout: 5 }),
      target?.end({ timeout: 5 }),
    ]);
  }
}

async function main() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim();
  const targetUrl = process.env.TARGET_DATABASE_URL?.trim();
  if (!sourceUrl || !targetUrl)
    throw new VerificationError(
      'SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required',
    );
  await verifyDatabaseTransfer(sourceUrl, targetUrl);
  console.log('Database transfer verification passed');
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(
      error instanceof VerificationError
        ? error.message
        : 'Database transfer verification failed',
    );
    process.exitCode = 1;
  });
}
