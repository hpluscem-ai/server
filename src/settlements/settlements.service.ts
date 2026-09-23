import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { AdminAuthRepository } from '../admin-auth';
import { DatabaseService } from '../database/database.service';
import { bankCodeOptions } from './bank-codes';
import {
  account,
  dayStart,
  integer,
  invalid,
  monthEnd,
} from './settlement-policy';
import {
  exportWorkbook,
  importWorkbook,
  type ExportRow,
  type TransferRow,
} from './settlement-excel';

type Snapshot = ExportRow & {
  settlement_id: string;
  settlement_month: string;
  transfer_status: string;
};
type Company = {
  id: string;
  businessName: string;
  businessNumber: string;
  corporateRegistrationNumber: string;
  businessAddress: string;
  managerName: string;
  managerPhone: string;
  bankCode: string;
  accountNumber: string;
  accountHolder: string;
  active: number;
};
const companiesSql = `SELECT id, business_name AS businessName, business_number AS businessNumber,
 corporate_registration_number AS corporateRegistrationNumber, business_address AS businessAddress,
 manager_name AS managerName, manager_phone AS managerPhone, bank_code AS bankCode,
 account_number AS accountNumber, account_holder AS accountHolder, active FROM logistics_companies`;
const eligible = `approval_status = 'approved' AND settlement_id IS NULL AND julianday(decided_at) < julianday(?)`;
const unpaid = `(s.id IS NULL OR s.transfer_status = 'pending')`;
const snapshotSql = `SELECT p.*, s.settlement_month, s.transfer_status FROM settlement_snapshots p JOIN settlements s ON s.id = p.settlement_id`;

@Injectable()
export class SettlementsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly admins: AdminAuthRepository,
  ) {}
  private get db() {
    return this.database.connection;
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(month: string) {
    const before = monthEnd(month);
    const candidates = new Map(
      (
        this.db
          .prepare(
            `SELECT logistics_company_id AS id, CAST(SUM(mileage_amount) AS TEXT) AS amount FROM mileage_applications WHERE ${eligible} GROUP BY logistics_company_id`,
          )
          .all(before) as { id: string; amount: string }[]
      ).map((row) => [row.id, integer(row.amount)]),
    );
    const existing = new Map(
      (
        this.db
          .prepare(
            `SELECT s.logistics_company_id AS id, s.transfer_status AS status, p.bank_code, p.account_number, p.account_holder,
      CAST(COALESCE(p.mileage_amount, (SELECT SUM(mileage_amount) FROM mileage_applications WHERE settlement_id = s.id), 0) AS TEXT) AS amount
      FROM settlements s LEFT JOIN settlement_snapshots p ON p.settlement_id = s.id WHERE s.settlement_month = ?`,
          )
          .all(month) as {
          id: string;
          status: string;
          bank_code: string | null;
          account_number: string | null;
          account_holder: string | null;
          amount: string;
        }[]
      ).map((row) => [row.id, row]),
    );
    const companies = this.db
      .prepare(`${companiesSql} ORDER BY business_name, id`)
      .all() as Company[];
    return companies
      .filter((c) => c.active || candidates.has(c.id) || existing.has(c.id))
      .map((c) => {
        const saved = existing.get(c.id);
        return {
          ...c,
          active: Boolean(c.active),
          bankCode:
            bankCodeOptions.find(
              (b) => Number(b.code) === Number(saved?.bank_code ?? c.bankCode),
            )?.code ??
            saved?.bank_code ??
            c.bankCode,
          accountNumber: saved?.account_number ?? c.accountNumber,
          accountHolder: saved?.account_holder ?? c.accountHolder,
          mileage: saved ? integer(saved.amount) : (candidates.get(c.id) ?? 0),
          transferStatus:
            saved?.status ?? (candidates.has(c.id) ? 'pending' : null),
        };
      });
  }

  export(month: string, adminId: string) {
    const before = monthEnd(month);
    if (Date.parse(before) > Date.now()) invalid('SETTLEMENT_MONTH_NOT_CLOSED');
    return this.transaction(() => {
      const legacy = this.db
        .prepare(
          `SELECT s.id FROM settlements s LEFT JOIN settlement_snapshots p ON p.settlement_id=s.id WHERE s.settlement_month=? AND s.transfer_status='pending' AND p.settlement_id IS NULL LIMIT 1`,
        )
        .get(month);
      if (legacy) invalid('SETTLEMENT_SNAPSHOT_MISSING');
      const groups = this.db
        .prepare(
          `SELECT logistics_company_id AS id, CAST(SUM(mileage_amount) AS TEXT) AS amount FROM mileage_applications WHERE ${eligible} GROUP BY logistics_company_id`,
        )
        .all(before) as { id: string; amount: string }[];
      for (const group of groups) {
        if (
          this.db
            .prepare(
              'SELECT id FROM settlements WHERE logistics_company_id=? AND settlement_month=?',
            )
            .get(group.id, month)
        )
          continue;
        const company = this.db
          .prepare(`${companiesSql} WHERE id=?`)
          .get(group.id) as Company;
        const bank = bankCodeOptions.find(
          (b) => Number(b.code) === Number(company.bankCode),
        );
        if (!bank || !company.accountHolder.trim())
          invalid('SETTLEMENT_ACCOUNT_INVALID');
        const accountNumber = account(company.accountNumber);
        const amount = integer(group.amount);
        const id = randomUUID();
        let reference: string;
        do {
          reference = String(randomInt(1_000_000_000, 10_000_000_000));
        } while (
          this.db
            .prepare('SELECT 1 FROM settlement_snapshots WHERE reference=?')
            .get(reference)
        );
        const now = new Date().toISOString();
        this.db
          .prepare(
            'INSERT INTO settlements(id,logistics_company_id,settlement_month,created_at,updated_at) VALUES(?,?,?,?,?)',
          )
          .run(id, company.id, month, now, now);
        this.db
          .prepare(
            `UPDATE mileage_applications SET settlement_id=? WHERE logistics_company_id=? AND ${eligible}`,
          )
          .run(id, company.id, before);
        this.db
          .prepare(
            `INSERT INTO settlement_snapshots(settlement_id,reference,bank_code,account_number,account_holder,mileage_amount,captured_at,captured_by) VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            reference,
            bank.code,
            accountNumber,
            company.accountHolder,
            amount,
            now,
            adminId,
          );
      }
      const rows = this.db
        .prepare(
          `${snapshotSql} WHERE s.settlement_month=? AND s.transfer_status='pending' ORDER BY p.reference`,
        )
        .all(month) as Snapshot[];
      return exportWorkbook(rows);
    });
  }

  private bankMatches(bank: string, code: string) {
    if (/^\d{1,3}$/.test(bank)) return Number(bank) === Number(code);
    const name = bankCodeOptions.find((b) => b.code === code)?.name;
    if (bank === name) return true;
    const aliases: Record<string, string[]> = {
      '81': ['하나', '하나은행'],
      '23': ['SC은행', 'SC제일', 'SC제일은행'],
      '11': ['농협', '농협은행', 'NH농협'],
      '12': ['농협', '지역농협', '지역농축협'],
    };
    return aliases[code]?.includes(bank) ?? false;
  }

  private resolveRow(
    row: TransferRow,
    snapshots: Map<string, Snapshot[]>,
    month: string,
  ): Snapshot {
    const key = row.reference
      ? `r:${row.reference}`
      : `d:${row.account}:${row.amount}`;
    const matches = (snapshots.get(key) ?? []).filter(
      (s) =>
        (!row.reference || s.reference === row.reference) &&
        s.account_number === row.account &&
        s.mileage_amount === row.amount &&
        this.bankMatches(row.bank, s.bank_code),
    );
    // Without CMS, match across all months so an old file cannot pay the next month's identical amount.
    if (matches.length !== 1 || matches[0].settlement_month !== month)
      invalid('SETTLEMENT_ROW_MISMATCH');
    return matches[0];
  }

  async import(month: string, bytes: Buffer, tokenHash: string) {
    monthEnd(month);
    const rows = await importWorkbook(bytes);
    const admin = this.admins.findSession(tokenHash);
    if (!admin)
      throw new UnauthorizedException({
        code: 'INVALID_ADMIN_SESSION',
        message: '관리자 로그인이 필요합니다.',
      });
    return this.transaction(() => {
      const snapshots = this.db.prepare(snapshotSql).all() as Snapshot[];
      const index = new Map<string, Snapshot[]>();
      for (const snapshot of snapshots) {
        for (const key of [
          `r:${snapshot.reference}`,
          `d:${snapshot.account_number}:${snapshot.mileage_amount}`,
        ]) {
          const group = index.get(key);
          if (group) group.push(snapshot);
          else index.set(key, [snapshot]);
        }
      }
      const targets = rows.map((row) => this.resolveRow(row, index, month));
      if (new Set(targets.map((s) => s.settlement_id)).size !== targets.length)
        invalid('SETTLEMENT_DUPLICATE_ROW');
      const now = new Date().toISOString();
      const fileHash = createHash('sha256').update(bytes).digest('hex');
      let completed = 0;
      for (const target of targets) {
        if (target.transfer_status === 'completed') continue;
        this.db
          .prepare(
            'INSERT INTO settlement_completions(settlement_id,file_hash,completed_by,completed_at) VALUES(?,?,?,?)',
          )
          .run(target.settlement_id, fileHash, admin.id, now);
        const changed = this.db
          .prepare(
            "UPDATE settlements SET transfer_status='completed',transferred_at=?,updated_at=? WHERE id=? AND transfer_status='pending'",
          )
          .run(now, now, target.settlement_id);
        if (changed.changes !== 1)
          throw new Error('Concurrent settlement change');
        completed++;
      }
      return { completed, alreadyCompleted: targets.length - completed };
    });
  }

  balance(userId: string) {
    const row = this.db
      .prepare(
        `SELECT CAST(COALESCE(SUM(a.mileage_amount),0) AS TEXT) AS amount
      FROM mileage_applications a LEFT JOIN settlements s ON s.id=a.settlement_id
      WHERE a.user_id=? AND a.approval_status='approved' AND ${unpaid}`,
      )
      .get(userId) as { amount: string };
    return { accumulatedMileage: integer(row.amount) };
  }

  dashboard(from: string, through: string, companyId?: string) {
    const start = dayStart(from);
    const before = new Date(
      Date.parse(dayStart(through)) + 86400_000,
    ).toISOString();
    if (
      from > through ||
      Date.parse(before) - Date.parse(start) > 10001 * 86400_000
    )
      invalid('VALIDATION_ERROR');
    const totals = this.db
      .prepare(
        `SELECT
      CAST(COALESCE(SUM(CASE WHEN a.approval_status='approved' AND ${unpaid} AND julianday(a.decided_at)>=julianday(?) AND julianday(a.decided_at)<julianday(?) THEN a.mileage_amount ELSE 0 END),0) AS TEXT) AS accumulatedMileage,
      CAST(COALESCE(SUM(CASE WHEN a.approval_status='approved' AND ${unpaid} AND julianday(a.decided_at)<julianday(?) THEN a.mileage_amount ELSE 0 END),0) AS TEXT) AS settlementMileage,
      SUM(CASE WHEN a.match_status='matched' AND julianday(a.submitted_at)>=julianday(?) AND julianday(a.submitted_at)<julianday(?) THEN 1 ELSE 0 END) AS matchedCount,
      SUM(CASE WHEN a.match_status='mismatched' AND julianday(a.submitted_at)>=julianday(?) AND julianday(a.submitted_at)<julianday(?) THEN 1 ELSE 0 END) AS mismatchedCount
      FROM mileage_applications a LEFT JOIN settlements s ON s.id=a.settlement_id`,
      )
      .get(start, before, before, start, before, start, before) as Record<
      string,
      string | number | null
    >;
    const chart = this.db
      .prepare(
        `SELECT date(decided_at, '+9 hours') AS date, CAST(SUM(mileage_amount) AS TEXT) AS common,
      CAST(SUM(CASE WHEN logistics_company_id=? THEN mileage_amount ELSE 0 END) AS TEXT) AS affiliation
      FROM mileage_applications WHERE approval_status='approved' AND julianday(decided_at)>=julianday(?) AND julianday(decided_at)<julianday(?)
      GROUP BY date(decided_at, '+9 hours') ORDER BY date`,
      )
      .all(companyId ?? '', start, before) as {
      date: string;
      common: string;
      affiliation: string;
    }[];
    const receipts = this.db
      .prepare(
        `SELECT a.id, u.name AS driverName, date(a.submitted_at, '+9 hours') AS date,
      a.approval_status AS status, CASE WHEN a.approval_status='approved' THEN CAST(a.mileage_amount AS TEXT) END AS mileage
      FROM mileage_applications a JOIN users u ON u.id=a.user_id
      WHERE julianday(a.submitted_at)>=julianday(?) AND julianday(a.submitted_at)<julianday(?) ORDER BY julianday(a.submitted_at) DESC, a.id DESC LIMIT 5`,
      )
      .all(start, before) as {
      id: string;
      driverName: string;
      date: string;
      status: string;
      mileage: string | null;
    }[];
    const affiliations = this.db
      .prepare(
        'SELECT id AS value, business_name AS label FROM logistics_companies ORDER BY business_name, id',
      )
      .all() as { value: string; label: string }[];
    return {
      accumulatedMileage: integer(totals.accumulatedMileage),
      settlementMileage: integer(totals.settlementMileage),
      matchedCount: integer(totals.matchedCount ?? 0),
      mismatchedCount: integer(totals.mismatchedCount ?? 0),
      chart: chart.map((row) => ({
        date: row.date,
        common: integer(row.common),
        affiliation: integer(row.affiliation),
      })),
      receipts: receipts.map((row) => ({
        ...row,
        mileage: row.mileage === null ? null : integer(row.mileage),
      })),
      affiliations,
    };
  }
}
