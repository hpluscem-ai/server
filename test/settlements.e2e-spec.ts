import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import * as XLSX from 'xlsx';
import { createTestApp } from './helpers/create-test-app';
import { seedAdminSession } from './helpers/seed-admin-session';
import { DatabaseService } from '../src/database/database.service';
import { SettlementsService } from '../src/settlements';
import {
  uploadHeaders,
  downloadHeaders,
} from '../src/settlements/settlement-excel';
import { ADMIN_WEB_SESSION_COOKIE } from '../src/auth';
import { createTestDatabase } from './helpers/create-test-database';

const root = '/api/v1/admin/settlements';
const month = '2026-08';
type Snapshot = {
  settlement_id: string;
  reference: string;
  bank_code: string;
  account_number: string;
  mileage_amount: number;
};
function workbook(
  rows: unknown[][],
  format: 'biff8' | 'xlsx' | 'xlsm' = 'biff8',
  edit?: (wb: XLSX.WorkBook) => void,
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([uploadHeaders, ...rows]),
    'Sheet1',
  );
  edit?.(wb);
  return XLSX.write(wb, { type: 'buffer', bookType: format }) as Buffer;
}
// SheetJS deliberately writes cached values for BIFF formulas. Put a real BIFF8
// FORMULA record in this negative fixture, so the test cannot pass on plain numbers.
function withBiffFormula(bytes: Buffer): Buffer {
  const cfb = XLSX.CFB as {
    read: (
      bytes: Buffer,
      options: { type: string },
    ) => { FileIndex: { name: string; content: Uint8Array; size: number }[] };
    write: (container: unknown, options: { type: string }) => Buffer;
  };
  const container = cfb.read(bytes, { type: 'buffer' });
  const entry = container.FileIndex.find((item) => item.name === 'Workbook')!;
  const stream = Buffer.from(entry.content);
  for (let offset = 0; offset + 4 <= stream.length;) {
    const id = stream.readUInt16LE(offset),
      size = stream.readUInt16LE(offset + 2);
    if (
      id === 0x0203 &&
      stream.readUInt16LE(offset + 4) === 1 &&
      stream.readUInt16LE(offset + 6) === 2
    ) {
      const formula = Buffer.alloc(29);
      formula.writeUInt16LE(0x0006, 0);
      formula.writeUInt16LE(25, 2);
      stream.copy(formula, 4, offset + 4, offset + 10);
      formula.writeDoubleLE(3000, 10);
      formula.writeUInt16LE(3, 24);
      formula[26] = 0x1e;
      formula.writeUInt16LE(3000, 27);
      entry.content = Buffer.concat([
        stream.subarray(0, offset),
        formula,
        stream.subarray(offset + 4 + size),
      ]);
      entry.size = entry.content.length;
      const result = cfb.write(container, { type: 'buffer' });
      expect((XLSX.read(result).Sheets.Sheet1.C2 as XLSX.CellObject).f).toBe(
        '3000',
      );
      return result;
    }
    offset += size + 4;
  }
  throw new Error('Numeric fixture cell missing');
}

function row(s: Snapshot): unknown[] {
  return [
    s.bank_code.padStart(3, '0'),
    s.account_number,
    s.mileage_amount,
    '',
    '',
    s.reference,
    '',
  ];
}

describe('Settlement upload, immutable snapshots and dashboard (real HTTP, isolated DB)', () => {
  let app: INestApplication<App>;
  let database: DatabaseService;
  let service: SettlementsService;
  let authorization: string;
  let adminId: string;
  let companyId: string;
  let userId: string;
  let applicationId: string;
  const db = () => database.connection;
  const upload = (bytes: Buffer, selectedMonth = month) =>
    request(app.getHttpServer())
      .post(`${root}/import?month=${selectedMonth}`)
      .set('Authorization', authorization)
      .attach('file', bytes, 'paid.xls');
  const snapshots = async (): Promise<Snapshot[]> => {
    const rows = await db()<
      (Omit<Snapshot, 'mileage_amount'> & {
        mileage_amount: string;
      })[]
    >`SELECT * FROM app.settlement_snapshots ORDER BY reference`;
    return rows.map((snapshot) => ({
      ...snapshot,
      mileage_amount: Number(snapshot.mileage_amount),
    }));
  };
  const completed = async () =>
    Number(
      (
        await db()<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM app.settlements
          WHERE transfer_status = 'completed'`
      )[0].count,
    );
  async function addCompany(bank = '4', account = '001234567890') {
    const id = randomUUID();
    await db()`
      INSERT INTO app.logistics_companies(
        id, business_name, business_number, corporate_registration_number,
        business_address, manager_name, manager_phone, bank_code,
        account_number, account_holder
      ) VALUES (
        ${id}, ${'테스트 물류'}, ${id}, ${id}, ${'서울'}, ${'담당자'},
        ${'01012345678'}, ${bank}, ${account}, ${'예금주'}
      )`;
    return id;
  }
  async function addUser(company: string) {
    const id = randomUUID();
    await db()`
      INSERT INTO app.users(
        id, role, email, password_hash, name, phone, logistics_company_id,
        service_terms_consent, privacy_terms_consent
      ) VALUES (
        ${id}, 'driver', ${`${id}@example.test`}, 'unused', ${'기사'}, ${id}, ${company}, true, true
      )`;
    return id;
  }
  async function addApplication(
    company = companyId,
    user = userId,
    amount = 3000,
    decided = '2026-08-31T14:59:59.999Z',
    status = 'approved',
    matched = 'matched',
    submitted = '2026-08-20T00:00:00Z',
  ) {
    const id = randomUUID();
    await db()`
      INSERT INTO app.mileage_applications(
        id, user_id, logistics_company_id, idempotency_key, submitted_at, match_status
      ) VALUES (${id}, ${user}, ${company}, ${id}, ${submitted}, ${matched})`;
    for (const kind of ['receipt', 'meter'])
      await db()`
        INSERT INTO app.mileage_application_photos(
          id, mileage_application_id, kind, storage_key, content_type, byte_size
        ) VALUES (${randomUUID()}, ${id}, ${kind}, ${randomUUID()}, 'image/jpeg', 1)`;
    await db()`
      UPDATE app.mileage_applications
      SET approval_status = ${status}, mileage_amount = ${amount}, final_amount = 200000,
        decided_at = ${status === 'pending' ? null : decided}
      WHERE id = ${id}`;
    return id;
  }
  beforeEach(async () => {
    process.env.WEB_ORIGINS = 'http://localhost:5173';
    database = await createTestDatabase();
    app = await createTestApp([], database);
    service = app.get(SettlementsService);
    authorization = await seedAdminSession(database);
    adminId = (
      await db()<
        { id: string }[]
      >`SELECT id FROM app.users WHERE role = 'admin'`
    )[0].id;
    companyId = await addCompany();
    userId = await addUser(companyId);
    applicationId = await addApplication();
  });
  afterEach(async () => {
    await app?.close();
  });

  test('closed month export is true BIFF8, preserves template headers and account zeroes, and never completes payment', async () => {
    const res = await request(app.getHttpServer())
      .post(`${root}/export?month=${month}`)
      .set('Authorization', authorization)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const bytes = res.body as Buffer;
    expect(bytes.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
    const sheet = XLSX.read(bytes).Sheets.Sheet1;
    expect(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0]).toEqual(
      downloadHeaders,
    );
    expect(sheet.B2).toMatchObject({ t: 's', v: '001234567890' });
    expect((sheet.A2 as XLSX.CellObject).v).toBe('004');
    expect((sheet.C2 as XLSX.CellObject).v).toBe('3000');
    expect((sheet.H2 as XLSX.CellObject).v).toMatch(/^\d{10}$/);
    expect(await completed()).toBe(0);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toContain(
      'settlements-2026-08.xls',
    );
  });
  test('KST cutoff, late approvals, pending and rejected amounts are distinct', async () => {
    await addApplication(companyId, userId, 700, '2026-08-31T15:00:00.000Z');
    await addApplication(companyId, userId, 900, undefined, 'pending');
    await addApplication(companyId, userId, 800, undefined, 'rejected');
    expect((await service.list(month))[0].mileage).toBe(3000);
    await service.export(month, adminId);
    expect((await snapshots())[0].mileage_amount).toBe(3000);
    expect((await service.list('2026-09'))[0].mileage).toBe(700);
  });
  test('first download freezes applications and accounts; later candidates carry into next month', async () => {
    await service.export(month, adminId);
    const original = (await snapshots())[0];
    await db()`UPDATE app.logistics_companies SET account_number = '999999', bank_code = '81', account_holder = '변경' WHERE id = ${companyId}`;
    await addApplication(companyId, userId, 500);
    await service.export(month, adminId);
    expect(await snapshots()).toHaveLength(1);
    expect((await snapshots())[0]).toEqual(original);
    expect((await service.list(month))[0]).toMatchObject({
      mileage: 3000,
      accountNumber: '001234567890',
      bankCode: '4',
    });
    expect((await service.list('2026-09'))[0].mileage).toBe(500);
    await expect(
      db()`UPDATE app.mileage_applications SET mileage_amount = 1 WHERE id = ${applicationId}`,
    ).rejects.toThrow(/captured/);
    await expect(
      db()`UPDATE app.mileage_applications SET settlement_id = NULL WHERE id = ${applicationId}`,
    ).rejects.toThrow(/captured/);
    await expect(
      db()`DELETE FROM app.mileage_applications WHERE id = ${applicationId}`,
    ).rejects.toThrow();
    await expect(
      db()`UPDATE app.settlements SET settlement_month = '2026-07'`,
    ).rejects.toThrow();
  });
  test.each(['biff8', 'xlsx'] as const)(
    '%s valid uploaded paid rows complete once and identical reupload keeps timestamp',
    async (format) => {
      await service.export(month, adminId);
      const bytes = workbook((await snapshots()).map(row), format);
      expect((await upload(bytes).expect(200)).body).toEqual({
        completed: 1,
        alreadyCompleted: 0,
      });
      const first = (await db()`SELECT * FROM app.settlements`)[0];
      expect((await upload(bytes).expect(200)).body).toEqual({
        completed: 0,
        alreadyCompleted: 1,
      });
      expect((await db()`SELECT * FROM app.settlements`)[0]).toEqual(first);
      expect(await db()`SELECT * FROM app.settlement_completions`).toHaveLength(
        1,
      );
    },
  );
  test('two admins uploading the same file concurrently cannot complete twice', async () => {
    await service.export(month, adminId);
    const bytes = workbook((await snapshots()).map(row));
    const second = await seedAdminSession(database);
    const results = await Promise.all([
      upload(bytes),
      request(app.getHttpServer())
        .post(`${root}/import?month=${month}`)
        .set('Authorization', second)
        .attach('file', bytes, 'paid.xls'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      results.map((r) => (r.body as { completed: number }).completed).sort(),
    ).toEqual([0, 1]);
    expect(await completed()).toBe(1);
  });
  test('simultaneous exports create one immutable batch', async () => {
    const replies = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post(`${root}/export?month=${month}`)
          .set('Authorization', authorization),
      ),
    );
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    expect(await snapshots()).toHaveLength(1);
  });
  test('valid subset leaves other companies pending; mixed valid/error rows roll back the entire file', async () => {
    const company2 = await addCompany('81', '000222');
    await addApplication(company2, await addUser(company2), 5000);
    await service.export(month, adminId);
    const rows = (await snapshots()).map(row);
    const bad = [...rows[1]];
    bad[2] = 999;
    await upload(workbook([rows[0], bad])).expect(400);
    expect(await completed()).toBe(0);
    expect((await upload(workbook([rows[0]])).expect(200)).body).toEqual({
      completed: 1,
      alreadyCompleted: 0,
    });
    expect((await upload(workbook(rows)).expect(200)).body).toEqual({
      completed: 1,
      alreadyCompleted: 1,
    });
    expect(await completed()).toBe(2);
  });
  test.each([
    ['amount changed', 2, 3001],
    ['negative', 2, -1],
    ['fraction', 2, 0.5],
    ['unsafe integer', 2, 9007199254740992],
    ['formula text amount', 2, '=3000'],
    ['scientific amount', 2, '3e3'],
    ['empty amount', 2, ''],
    ['wrong account', 1, '991234567890'],
    ['masked account', 1, '**********'],
    ['numeric account', 1, 1234567890],
    ['empty bank', 0, ''],
    ['wrong bank', 0, '081'],
    ['wrong reference', 5, '1111111111'],
    ['invalid reference', 5, 'abc'],
  ])('reject %s without mutation', async (_name, column, value) => {
    await service.export(month, adminId);
    const r = row((await snapshots())[0]);
    r[column] = value;
    await upload(workbook([r])).expect(400);
    expect(await completed()).toBe(0);
  });
  test('duplicate rows reject the whole file, including equivalent bank code/name forms', async () => {
    await service.export(month, adminId);
    const a = row((await snapshots())[0]);
    const b = [...a];
    b[0] = 'KB국민은행';
    const res = await upload(workbook([a, b])).expect(400);
    expect((res.body as { code: string }).code).toBe(
      'SETTLEMENT_DUPLICATE_ROW',
    );
    expect(await completed()).toBe(0);
  });
  test('missing CMS is accepted only when bank/account/amount is globally unique', async () => {
    await service.export(month, adminId);
    const r = row((await snapshots())[0]);
    r[5] = '';
    await upload(workbook([r])).expect(200);
    expect(await completed()).toBe(1);
  });
  test('same account and amount across months require CMS; old file cannot complete the next month', async () => {
    await db()`UPDATE app.mileage_applications SET decided_at = '2026-07-31T00:00:00Z' WHERE id = ${applicationId}`;
    await service.export('2026-07', adminId);
    const previous = (await snapshots())[0];
    await upload(workbook([row(previous)]), '2026-07').expect(200);
    await addApplication();
    await service.export(month, adminId);
    const current = (await snapshots()).find(
      (s) => s.settlement_id !== previous.settlement_id,
    )!;
    const noCms = row(current);
    noCms[5] = '';
    await upload(workbook([noCms])).expect(400);
    await upload(workbook([row(previous)])).expect(400);
    expect(await completed()).toBe(1);
    await upload(workbook([row(current)])).expect(200);
    expect(await completed()).toBe(2);
  });
  test.each(['2026-07', '2026-09'])(
    'wrong selected month %s refuses an otherwise valid file',
    async (selected) => {
      await service.export(month, adminId);
      await upload(workbook((await snapshots()).map(row)), selected).expect(
        400,
      );
      expect(await completed()).toBe(0);
    },
  );
  test('inactive companies and withdrawn drivers retain settlement records and can be paid', async () => {
    await service.export(month, adminId);
    await db()`UPDATE app.users SET deactivated_at = ${new Date().toISOString()} WHERE id = ${userId}`;
    await db()`UPDATE app.logistics_companies SET active = false WHERE id = ${companyId}`;
    expect((await service.list(month))[0].active).toBe(false);
    await upload(workbook((await snapshots()).map(row))).expect(200);
    expect(await completed()).toBe(1);
  });
  test('same destination across companies requires CMS', async () => {
    const other = await addCompany();
    await addApplication(other, await addUser(other));
    await service.export(month, adminId);
    const r = row((await snapshots())[0]);
    r[5] = '';
    await upload(workbook([r])).expect(400);
    expect(await completed()).toBe(0);
    await upload(workbook((await snapshots()).map(row))).expect(200);
    expect(await completed()).toBe(2);
  });
  test.each([
    'formula',
    'link',
    'extra-column',
    'changed-header',
    'extra-sheet',
    'hidden',
    'merged',
    'external-name',
    'macro',
  ])('reject workbook hazard %s', async (hazard) => {
    await service.export(month, adminId);
    const bytes = workbook(
      (await snapshots()).map(row),
      hazard === 'macro' ? 'xlsm' : 'xlsx',
      (wb) => {
        const s = wb.Sheets.Sheet1;
        if (hazard === 'formula') s.C2 = { t: 'n', v: 3000, f: '1500+1500' };
        if (hazard === 'link')
          (s.B2 as XLSX.CellObject).l = { Target: 'https://example.invalid/' };
        if (hazard === 'extra-column') {
          s.H2 = { t: 's', v: 'extra' };
          s['!ref'] = 'A1:H2';
        }
        if (hazard === 'changed-header') (s.C1 as XLSX.CellObject).v = '입금액';
        if (hazard === 'extra-sheet')
          XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.aoa_to_sheet([['extra']]),
            'Sheet2',
          );
        if (hazard === 'hidden')
          wb.Workbook = { Sheets: [{ name: 'Sheet1', Hidden: 1 }] };
        if (hazard === 'merged')
          s['!merges'] = [XLSX.utils.decode_range('A2:B2')];
        if (hazard === 'external-name')
          wb.Workbook = {
            Names: [{ Name: 'external', Ref: '[book.xls]Sheet1!A1' }],
          };
        if (hazard === 'macro') wb.vbaraw = Buffer.from('macro');
      },
    );
    await upload(bytes).expect(400);
    expect(await completed()).toBe(0);
  });
  test('empty workbook and disguised text/HTML files are not spreadsheets', async () => {
    await service.export(month, adminId);
    for (const bytes of [
      Buffer.from('bank,account,amount'),
      Buffer.from('<table><tr><td>3000</td></tr></table>'),
      workbook([]),
    ])
      await upload(bytes).expect(400);
    expect(await completed()).toBe(0);
  });
  test('file size and row limits do not write partial results', async () => {
    await service.export(month, adminId);
    await upload(Buffer.alloc(5 * 1024 * 1024 + 1)).expect(413);
    const snapshot = (await snapshots())[0];
    await upload(
      workbook(Array.from({ length: 10001 }, () => row(snapshot))),
    ).expect(400);
    expect(await completed()).toBe(0);
  });
  test('extra files and multipart fields are rejected', async () => {
    await service.export(month, adminId);
    const bytes = workbook((await snapshots()).map(row));
    await request(app.getHttpServer())
      .post(`${root}/import?month=${month}`)
      .set('Authorization', authorization)
      .attach('file', bytes, 'paid.xls')
      .attach('file', bytes, 'second.xls')
      .expect(400);
    await request(app.getHttpServer())
      .post(`${root}/import?month=${month}`)
      .set('Authorization', authorization)
      .field('complete', 'true')
      .attach('file', bytes, 'paid.xls')
      .expect(400);
    expect(await completed()).toBe(0);
  });
  test('session revoked while parsing cannot complete settlement', async () => {
    await service.export(month, adminId);
    const pending = service.import(
      month,
      workbook((await snapshots()).map(row)),
      createHash('sha256').update(authorization.slice(7)).digest('hex'),
    );
    await db()`DELETE FROM app.admin_sessions`;
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(await completed()).toBe(0);
  });
  test('no administrator, driver token and wrong web origins cannot mutate settlements', async () => {
    const driverToken = randomBytes(32).toString('base64url'),
      now = Date.now();
    await db()`
      INSERT INTO app.auth_sessions(token_hash, user_id, created_at, last_used_at, expires_at)
      VALUES (
        ${createHash('sha256').update(driverToken).digest('hex')}, ${userId},
        ${new Date(now).toISOString()}, ${new Date(now).toISOString()},
        ${new Date(now + 600000).toISOString()}
      )`;
    for (const path of [
      `${root}?month=${month}`,
      '/api/v1/admin/dashboard?from=2026-08-01&through=2026-08-31',
    ]) {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${driverToken}`)
        .expect(401);
    }
    const cookie = `${ADMIN_WEB_SESSION_COOKIE}=${authorization.slice(7)}`;
    for (const origin of ['', 'https://evil.example']) {
      await request(app.getHttpServer())
        .post(`${root}/export?month=${month}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .expect(403);
      await request(app.getHttpServer())
        .post(`${root}/import?month=${month}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .attach('file', workbook([]), 'paid.xls')
        .expect(403);
    }
    await request(app.getHttpServer())
      .post(`${root}/export?month=${month}`)
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(await snapshots()).toHaveLength(1);
    expect(await completed()).toBe(0);
  });
  test('server aggregation uses approval dates for money, submission dates for counts, all companies and newest five', async () => {
    await addApplication(
      companyId,
      userId,
      100,
      '2026-07-31T14:59:59Z',
      'approved',
      'pending',
    );
    await addApplication(
      companyId,
      userId,
      200,
      '2026-08-31T15:00:00Z',
      'approved',
      'mismatched',
    );
    await addApplication(
      companyId,
      userId,
      999,
      undefined,
      'pending',
      'ocr_failed',
    );
    await addApplication(
      companyId,
      userId,
      999,
      undefined,
      'rejected',
      'duplicate_suspected',
    );
    const other = await addCompany('81', '00022');
    await addApplication(
      other,
      await addUser(other),
      400,
      '2026-08-02T00:00:00Z',
    );
    const data = await service.dashboard('2026-08-01', '2026-08-31', companyId);
    expect(data).toMatchObject({
      accumulatedMileage: 3400,
      settlementMileage: 3500,
      matchedCount: 2,
      mismatchedCount: 1,
    });
    expect(data.receipts).toHaveLength(5);
    expect(data.chart.reduce((sum, r) => sum + r.common, 0)).toBe(3400);
    expect(data.chart.reduce((sum, r) => sum + r.affiliation, 0)).toBe(3000);
    await service.export(month, adminId);
    await upload(workbook((await snapshots()).map(row))).expect(200);
    const after = await service.dashboard(
      '2026-08-01',
      '2026-08-31',
      companyId,
    );
    expect(after.accumulatedMileage).toBe(0);
    expect(after.settlementMileage).toBe(0);
    expect(after.chart).toEqual(data.chart);
    expect(after.matchedCount).toBe(2);
  });
  test('completed rows disappear from driver list and detail, pending/rejected stay visible', async () => {
    await addApplication(companyId, userId, 999, undefined, 'pending');
    await addApplication(companyId, userId, 999, undefined, 'rejected');
    const token = randomBytes(32).toString('base64url'),
      now = Date.now();
    await db()`
      INSERT INTO app.auth_sessions(token_hash, user_id, created_at, last_used_at, expires_at)
      VALUES (
        ${createHash('sha256').update(token).digest('hex')}, ${userId},
        ${new Date(now).toISOString()}, ${new Date(now).toISOString()},
        ${new Date(now + 600000).toISOString()}
      )`;
    const driver = request(app.getHttpServer());
    const before = await driver
      .get('/api/v1/mileage/applications?limit=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((before.body as { items: unknown[] }).items).toHaveLength(1);
    const balance = await driver
      .get('/api/v1/mileage/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(balance.body).toEqual({ accumulatedMileage: 3000 });
    await service.export(month, adminId);
    await upload(workbook((await snapshots()).map(row))).expect(200);
    await driver
      .get(`/api/v1/mileage/applications/${applicationId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const after = await driver
      .get('/api/v1/mileage/applications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const balanceAfter = await driver
      .get('/api/v1/mileage/summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(balanceAfter.body).toEqual({ accumulatedMileage: 0 });
    expect((after.body as { items: { status: string }[] }).items).toHaveLength(
      2,
    );
    expect(
      (after.body as { items: { status: string }[] }).items.every(
        (r: { status: string }) => r.status !== 'approved',
      ),
    ).toBe(true);
  });

  test('a database failure on a later completion rolls back all statuses and audit records', async () => {
    const second = await addCompany('81', '00033');
    await addApplication(second, await addUser(second), 4000);
    await service.export(month, adminId);
    await db().unsafe(
      'ALTER TABLE app.settlement_completions ADD CONSTRAINT test_file_hash_unique UNIQUE(file_hash)',
    );
    await upload(workbook((await snapshots()).map(row))).expect(500);
    expect(await completed()).toBe(0);
    expect(await db()`SELECT * FROM app.settlement_completions`).toEqual([]);
  });
  test('safe individual amounts with an unsafe combined sum cannot be displayed or captured', async () => {
    await addApplication(companyId, userId, Number.MAX_SAFE_INTEGER);
    await request(app.getHttpServer())
      .get(`${root}?month=${month}`)
      .set('Authorization', authorization)
      .expect(400);
    await request(app.getHttpServer())
      .post(`${root}/export?month=${month}`)
      .set('Authorization', authorization)
      .expect(400);
    expect(await snapshots()).toHaveLength(0);
  });
  test('zero approved mileage is preserved exactly without including receipt principal', async () => {
    await db()`UPDATE app.mileage_applications SET mileage_amount = 0 WHERE id = ${applicationId}`;
    await service.export(month, adminId);
    expect((await snapshots())[0].mileage_amount).toBe(0);
    await upload(workbook((await snapshots()).map(row))).expect(200);
    expect(await completed()).toBe(1);
  });
  test('blank sheets and blank rows from the supplied upload format are accepted', async () => {
    await service.export(month, adminId);
    const bytes = workbook(
      [[], ...(await snapshots()).map(row), []],
      'biff8',
      (wb) => {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Sheet2');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Sheet3');
      },
    );
    await upload(bytes).expect(200);
    expect(await completed()).toBe(1);
  });
  test('a supplied download-format file cannot be uploaded as a paid result', async () => {
    const bytes = await service.export(month, adminId);
    await upload(bytes).expect(400);
    expect(await completed()).toBe(0);
  });
  test('legacy pending records without frozen bank data are not silently rebuilt', async () => {
    await db()`
      INSERT INTO app.settlements(id, logistics_company_id, settlement_month, transfer_status)
      VALUES (${randomUUID()}, ${companyId}, ${month}, 'pending')`;
    const res = await request(app.getHttpServer())
      .post(`${root}/export?month=${month}`)
      .set('Authorization', authorization)
      .expect(400);
    expect((res.body as { code: string }).code).toBe(
      'SETTLEMENT_SNAPSHOT_MISSING',
    );
    expect(await snapshots()).toHaveLength(0);
  });
  test('completed batches cannot be cancelled, exported again, or have their evidence changed', async () => {
    await service.export(month, adminId);
    await upload(workbook((await snapshots()).map(row))).expect(200);
    await expect(
      db()`UPDATE app.settlements SET transfer_status = 'pending', transferred_at = NULL`,
    ).rejects.toThrow();
    await expect(
      db()`UPDATE app.settlement_completions SET file_hash = 'changed'`,
    ).rejects.toThrow();
    await expect(
      db()`DELETE FROM app.settlement_completions`,
    ).rejects.toThrow();
    await expect(service.export(month, adminId)).rejects.toThrow();
  });
  test('changing account information after export does not accept payment to the new account', async () => {
    await service.export(month, adminId);
    const r = row((await snapshots())[0]);
    await db()`UPDATE app.logistics_companies SET account_number = '009999' WHERE id = ${companyId}`;
    r[1] = '009999';
    await upload(workbook([r])).expect(400);
    expect(await completed()).toBe(0);
    await upload(workbook((await snapshots()).map(row))).expect(200);
  });
  test('all-month balance exceeds a single page and isolates the current driver', async () => {
    for (let i = 0; i < 25; i++) await addApplication(companyId, userId, 10);
    await addApplication(companyId, await addUser(companyId), 700);
    expect(await service.balance(userId)).toEqual({ accumulatedMileage: 3250 });
  });
  test('no approved record is dropped at the leap-day and year KST boundaries', async () => {
    await addApplication(companyId, userId, 10, '2024-02-29T14:59:59.999Z');
    await addApplication(companyId, userId, 20, '2024-02-29T15:00:00Z');
    await addApplication(companyId, userId, 30, '2024-12-31T14:59:59.999Z');
    await addApplication(companyId, userId, 40, '2024-12-31T15:00:00Z');
    expect((await service.list('2024-02'))[0].mileage).toBe(10);
    expect(
      (await service.dashboard('2024-02-29', '2024-02-29')).accumulatedMileage,
    ).toBe(10);
    expect((await service.list('2024-12'))[0].mileage).toBe(60);
  });
  test('Swagger publishes all three settlement endpoints, dashboard and full balance contract', async () => {
    const res = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    for (const path of [
      root,
      `${root}/export`,
      `${root}/import`,
      '/api/v1/admin/dashboard',
      '/api/v1/mileage/summary',
    ])
      expect(
        (res.body as { paths: Record<string, unknown> }).paths[path],
      ).toBeDefined();
  });

  test('the current review rejection API refuses a captured approved application', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/mileage/applications/${applicationId}`)
      .set('Authorization', authorization)
      .expect(200);
    await service.export(month, adminId);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/mileage/applications/${applicationId}/reject`)
      .set('Authorization', authorization)
      .send({
        rejectionReason: '금액 불일치',
        reviewVersion: (detail.body as { reviewVersion: string }).reviewVersion,
      })
      .expect(409);
    expect((await snapshots())[0].mileage_amount).toBe(3000);
  });
  test('concurrent review rejection and settlement export exclude pending mileage consistently', async () => {
    const pending = await addApplication(
      companyId,
      userId,
      9000,
      undefined,
      'pending',
    );
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/mileage/applications/${pending}`)
      .set('Authorization', authorization)
      .expect(200);
    const results = await Promise.all([
      request(app.getHttpServer())
        .post(`${root}/export?month=${month}`)
        .set('Authorization', authorization),
      request(app.getHttpServer())
        .post(`/api/v1/admin/mileage/applications/${pending}/reject`)
        .set('Authorization', authorization)
        .send({
          rejectionReason: '금액 불일치',
          reviewVersion: (detail.body as { reviewVersion: string })
            .reviewVersion,
        }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await snapshots())[0].mileage_amount).toBe(3000);
    expect(
      (
        await db()`SELECT settlement_id, approval_status FROM app.mileage_applications WHERE id = ${pending}`
      )[0],
    ).toMatchObject({ settlement_id: null, approval_status: 'rejected' });
  });
  test.each(['formula', 'link'] as const)(
    'legacy XLS %s is rejected before completion',
    async (hazard) => {
      await service.export(month, adminId);
      let bytes = workbook((await snapshots()).map(row), 'biff8', (wb) => {
        if (hazard === 'formula')
          wb.Sheets.Sheet1.C2 = { t: 'n', v: 3000, f: 'SUM(1000,2000)' };
        else
          (wb.Sheets.Sheet1.B2 as XLSX.CellObject).l = {
            Target: 'https://example.invalid/',
          };
      });
      if (hazard === 'formula') bytes = withBiffFormula(bytes);
      const response = await upload(bytes).expect(400);
      expect((response.body as { code: string }).code).toBe(
        'SETTLEMENT_FILE_INVALID',
      );
      expect(await completed()).toBe(0);
    },
  );
  test('legacy zero-padded stored bank codes preserve the same financial institution', async () => {
    await db()`UPDATE app.logistics_companies SET bank_code = '004' WHERE id = ${companyId}`;
    expect((await service.list(month))[0].bankCode).toBe('4');
    await service.export(month, adminId);
    expect((await snapshots())[0].bank_code).toBe('4');
    await upload(workbook((await snapshots()).map(row))).expect(200);
  });
  test.each(['2026-00', '2026-13', '26-08', '2026-08-01'])(
    'invalid month %s rejected',
    async (value) => {
      await request(app.getHttpServer())
        .get(`${root}?month=${value}`)
        .set('Authorization', authorization)
        .expect(400);
    },
  );
  test('unclosed month export cannot capture records, and no eligible rows is an error rather than a completed payment', async () => {
    await expect(service.export('9999-01', adminId)).rejects.toThrow();
    await expect(service.export('2026-01', adminId)).rejects.toThrow();
    expect(await snapshots()).toHaveLength(0);
  });
  test('empty successful dashboard returns real zeroes and an empty chart', async () => {
    expect(await service.dashboard('2025-01-01', '2025-01-31')).toMatchObject({
      accumulatedMileage: 0,
      settlementMileage: 0,
      matchedCount: 0,
      mismatchedCount: 0,
      chart: [],
      receipts: [],
    });
  });
  test.each([
    ['2026-02-30', '2026-03-01'],
    ['2026-09-01', '2026-08-01'],
    ['2026-1-01', '2026-02-01'],
  ])('invalid date range %s %s rejected', async (from, through) => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/dashboard?from=${from}&through=${through}`)
      .set('Authorization', authorization)
      .expect(400);
  });
});
