import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
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
  transfer_status: 'pending' | 'completed';
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
  active: boolean;
};
type Amount = { amount: string | number };
const matchingKey = (accountHolder: string, amount: number) =>
  JSON.stringify([accountHolder.trim(), amount]);
type Settlement = {
  id: string;
  status: 'pending' | 'completed';
  bank_code: string | null;
  account_number: string | null;
  account_holder: string | null;
  amount: string | number;
};

const companiesSql = `SELECT id, business_name AS "businessName", business_number AS "businessNumber",
 corporate_registration_number AS "corporateRegistrationNumber", business_address AS "businessAddress",
 manager_name AS "managerName", manager_phone AS "managerPhone", bank_code AS "bankCode",
 account_number AS "accountNumber", account_holder AS "accountHolder", active FROM app.logistics_companies`;
const snapshotSql = `SELECT p.*, s.settlement_month, s.transfer_status
  FROM app.settlement_snapshots p JOIN app.settlements s ON s.id = p.settlement_id`;

@Injectable()
export class SettlementsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly admins: AdminAuthRepository,
  ) {}

  private get db() {
    return this.database.connection;
  }

  private eligibleApplications(month: string) {
    const before = monthEnd(month);
    // Keep the original KST registration month unless that company's earlier
    // monthly files are already frozen. A gap stops carryover at that month.
    return this.db`
      a.approval_status = 'approved' AND a.settlement_id IS NULL
      AND a.submitted_at::timestamptz < ${before}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM generate_series(
          date_trunc('month', a.submitted_at::timestamptz AT TIME ZONE 'Asia/Seoul'),
          ${`${month}-01`}::timestamp - interval '1 month', interval '1 month'
        ) AS prior(month)
        WHERE NOT EXISTS (
          SELECT 1 FROM app.settlements s
          LEFT JOIN app.settlement_snapshots p ON p.settlement_id = s.id
          WHERE s.logistics_company_id = a.logistics_company_id
            AND s.settlement_month = to_char(prior.month, 'YYYY-MM')
            AND (p.settlement_id IS NOT NULL OR s.transfer_status = 'completed')
        )
      )`;
  }

  async list(month: string) {
    const eligible = this.eligibleApplications(month);
    const [candidates, registered, existing, companies] = await Promise.all([
      this.db<{ id: string; amount: string | number }[]>`
        SELECT logistics_company_id AS id, SUM(mileage_amount)::text AS amount
        FROM app.mileage_applications a
        WHERE ${eligible}
        GROUP BY logistics_company_id`,
      this.db<{ id: string; amount: string; unpaidOutsideMonth: string }[]>`
        SELECT a.logistics_company_id AS id, SUM(a.mileage_amount)::text AS amount,
          COALESCE(SUM(a.mileage_amount) FILTER (
            WHERE (s.id IS NULL OR s.settlement_month <> ${month})
              AND s.transfer_status IS DISTINCT FROM 'completed'
          ), 0)::text AS "unpaidOutsideMonth"
        FROM app.mileage_applications a
        LEFT JOIN app.settlements s ON s.id = a.settlement_id
        WHERE a.approval_status = 'approved'
          AND a.submitted_at::timestamptz >= ${dayStart(`${month}-01`)}::timestamptz
          AND a.submitted_at::timestamptz < ${monthEnd(month)}::timestamptz
        GROUP BY a.logistics_company_id`,
      this.db<Settlement[]>`
        SELECT s.logistics_company_id AS id, s.transfer_status AS status, p.bank_code, p.account_number, p.account_holder,
          COALESCE(p.mileage_amount, (
            SELECT SUM(mileage_amount) FROM app.mileage_applications WHERE settlement_id = s.id
          ), 0)::text AS amount
        FROM app.settlements s
        LEFT JOIN app.settlement_snapshots p ON p.settlement_id = s.id
        WHERE s.settlement_month = ${month}`,
      this.db<
        Company[]
      >`${this.db.unsafe(companiesSql)} ORDER BY business_name, id`,
    ]);
    const candidateAmounts = new Map(
      candidates.map((row) => [row.id, integer(row.amount)]),
    );
    const registeredAmounts = new Map(
      registered.map((row) => [
        row.id,
        {
          amount: integer(row.amount),
          unpaidOutsideMonth: integer(row.unpaidOutsideMonth),
        },
      ]),
    );
    const savedSettlements = new Map(existing.map((row) => [row.id, row]));
    return companies
      .filter(
        (company) =>
          company.active ||
          candidateAmounts.has(company.id) ||
          registeredAmounts.has(company.id) ||
          savedSettlements.has(company.id),
      )
      .map((company) => {
        const saved = savedSettlements.get(company.id);
        return {
          ...company,
          bankCode:
            bankCodeOptions.find(
              (bank) =>
                Number(bank.code) ===
                Number(saved?.bank_code ?? company.bankCode),
            )?.code ??
            saved?.bank_code ??
            company.bankCode,
          accountNumber: saved?.account_number ?? company.accountNumber,
          accountHolder: saved?.account_holder ?? company.accountHolder,
          mileage: saved
            ? integer(saved.amount)
            : (candidateAmounts.get(company.id) ?? 0),
          registeredMileage: registeredAmounts.get(company.id)?.amount ?? 0,
          additionalUnpaidMileage: saved
            ? (registeredAmounts.get(company.id)?.unpaidOutsideMonth ?? 0)
            : 0,
          transferStatus:
            saved?.status ??
            (candidateAmounts.has(company.id) ? 'pending' : null),
        };
      });
  }

  private async capture(month: string, adminId: string, tx: TransactionSql) {
    const eligible = this.eligibleApplications(month);
    const legacy = await tx<{ id: string }[]>`
        SELECT s.id
        FROM app.settlements s
        LEFT JOIN app.settlement_snapshots p ON p.settlement_id = s.id
        WHERE s.settlement_month = ${month}
          AND s.transfer_status = 'pending'
          AND p.settlement_id IS NULL
        LIMIT 1`;
    if (legacy.length) invalid('SETTLEMENT_SNAPSHOT_MISSING');

    const groups = await tx<{ id: string }[]>`
        SELECT logistics_company_id AS id
        FROM app.mileage_applications a
        WHERE ${eligible}
        GROUP BY logistics_company_id`;
    for (const group of groups) {
      const existing = await tx<{ id: string }[]>`
          SELECT id FROM app.settlements
          WHERE logistics_company_id = ${group.id} AND settlement_month = ${month}
          FOR UPDATE`;
      if (existing.length) continue;

      const companies = await tx<
        Company[]
      >`${tx.unsafe(companiesSql)} WHERE id = ${group.id}`;
      const company = companies[0];
      if (!company) continue;
      const bank = bankCodeOptions.find(
        (candidate) => Number(candidate.code) === Number(company.bankCode),
      );
      if (!bank || !company.accountHolder.trim())
        invalid('SETTLEMENT_ACCOUNT_INVALID');
      const id = randomUUID();
      const now = new Date().toISOString();
      await tx`
          INSERT INTO app.settlements(
            id, logistics_company_id, settlement_month, transfer_status, created_at, updated_at
          ) VALUES (${id}, ${company.id}, ${month}, 'pending', ${now}, ${now})`;
      const captured = await tx<Amount[]>`
          UPDATE app.mileage_applications a
          SET settlement_id = ${id}
          WHERE logistics_company_id = ${company.id}
            AND ${eligible}
          RETURNING mileage_amount::text AS amount`;
      const amount = integer(
        captured
          .reduce((total, row) => total + BigInt(String(row.amount)), 0n)
          .toString(),
      );
      if (!captured.length)
        throw new Error('Settlement capture lost its eligible applications');

      for (let attempt = 0; attempt < 10; attempt++) {
        const reference = String(randomInt(1_000_000_000, 10_000_000_000));
        const inserted = await tx<{ reference: string }[]>`
            INSERT INTO app.settlement_snapshots(
              settlement_id, reference, bank_code, account_number, account_holder,
              mileage_amount, captured_at, captured_by
            ) VALUES (
              ${id}, ${reference}, ${bank.code}, ${account(company.accountNumber)},
              ${company.accountHolder}, ${amount}, ${now}, ${adminId}
            )
            ON CONFLICT (reference) DO NOTHING
            RETURNING reference`;
        if (inserted.length) break;
        if (attempt === 9)
          throw new Error('Unable to allocate settlement reference');
      }
    }
  }

  async export(month: string, adminId: string) {
    return this.db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('settlement:' || ${month}))`;
      await this.capture(month, adminId, tx);
      const rows = await tx<Snapshot[]>`
        ${tx.unsafe(snapshotSql)}
        WHERE s.settlement_month = ${month} AND s.transfer_status = 'pending'
        ORDER BY p.reference`;
      return exportWorkbook(
        rows.map((row) => ({
          ...row,
          mileage_amount: integer(row.mileage_amount),
        })),
      );
    });
  }

  private bankMatches(bank: string, code: string) {
    if (/^\d{1,3}$/.test(bank)) return Number(bank) === Number(code);
    const name = bankCodeOptions.find(
      (candidate) => candidate.code === code,
    )?.name;
    if (bank === name) return true;
    const aliases: Record<string, string[]> = {
      '81': ['하나', '하나은행'],
      '23': ['SC은행', 'SC제일', 'SC제일은행'],
      '11': ['농협', '농협은행', 'NH농협'],
      '12': ['농협', '지역농협', '지역농축협'],
    };
    return aliases[code]?.includes(bank) ?? false;
  }

  private indexSnapshots(snapshots: Snapshot[]) {
    const index = new Map<string, Snapshot[]>();
    for (const snapshot of snapshots) {
      const accountHolder = snapshot.account_holder?.trim();
      if (!accountHolder) continue;
      const key = matchingKey(accountHolder, integer(snapshot.mileage_amount));
      const group = index.get(key);
      if (group) group.push(snapshot);
      else index.set(key, [snapshot]);
    }
    return index;
  }

  private matches(
    row: TransferRow,
    snapshots: Map<string, Snapshot[]>,
  ): Snapshot[] {
    return (
      snapshots.get(matchingKey(row.accountHolder, row.amount)) ?? []
    ).filter((snapshot) => this.bankMatches(row.bank, snapshot.bank_code));
  }

  private resolveRow(
    row: TransferRow,
    snapshots: Map<string, Snapshot[]>,
    month: string,
  ): Snapshot {
    const matches = this.matches(row, snapshots);
    if (matches.length !== 1 || matches[0].settlement_month !== month)
      invalid('SETTLEMENT_ROW_MISMATCH');
    return matches[0];
  }

  async import(month: string, bytes: Buffer, tokenHash: string) {
    monthEnd(month);
    const rows = await importWorkbook(bytes);
    const admin = await this.admins.findSession(tokenHash);
    if (!admin)
      throw new UnauthorizedException({
        code: 'INVALID_ADMIN_SESSION',
        message: '관리자 로그인이 필요합니다.',
      });
    return this.db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('settlement:' || ${month}))`;
      const existing = await tx<Snapshot[]>`${tx.unsafe(snapshotSql)}`;
      const existingIndex = this.indexSnapshots(existing);
      if (
        rows.some((row) => {
          const matches = this.matches(row, existingIndex);
          return matches.length !== 1 || matches[0].settlement_month !== month;
        })
      )
        await this.capture(month, admin.id, tx);
      // Lock the settlement rows before interpreting their completion state.
      const snapshots = await tx<Snapshot[]>`
        ${tx.unsafe(snapshotSql)}
        FOR UPDATE OF s`;
      const index = this.indexSnapshots(snapshots);
      const targets = rows.map((row) => this.resolveRow(row, index, month));
      if (
        new Set(targets.map((target) => target.settlement_id)).size !==
        targets.length
      )
        invalid('SETTLEMENT_DUPLICATE_ROW');

      const now = new Date().toISOString();
      const fileHash = createHash('sha256').update(bytes).digest('hex');
      let completed = 0;
      for (const target of targets) {
        if (target.transfer_status === 'completed') continue;
        await tx`
          INSERT INTO app.settlement_completions(settlement_id, file_hash, completed_by, completed_at)
          VALUES (${target.settlement_id}, ${fileHash}, ${admin.id}, ${now})`;
        const changed = await tx<{ id: string }[]>`
          UPDATE app.settlements
          SET transfer_status = 'completed', transferred_at = ${now}, updated_at = ${now}
          WHERE id = ${target.settlement_id} AND transfer_status = 'pending'
          RETURNING id`;
        if (changed.length !== 1)
          throw new Error('Concurrent settlement change');
        completed++;
      }
      return { completed, alreadyCompleted: targets.length - completed };
    });
  }

  async balance(userId: string) {
    const rows = await this.db<Amount[]>`
      SELECT COALESCE(SUM(a.mileage_amount), 0)::text AS amount
      FROM app.mileage_applications a
      LEFT JOIN app.settlements s ON s.id = a.settlement_id
      WHERE a.user_id = ${userId}
        AND a.approval_status = 'approved'
        AND (s.id IS NULL OR s.transfer_status = 'pending')`;
    return { accumulatedMileage: integer(rows[0].amount) };
  }

  async dashboard(from: string, through: string, companyId?: string) {
    const start = dayStart(from);
    const before = new Date(
      Date.parse(dayStart(through)) + 86400_000,
    ).toISOString();
    if (
      from > through ||
      Date.parse(before) - Date.parse(start) > 10001 * 86400_000
    )
      invalid('VALIDATION_ERROR');
    const [totalsRows, chart, receipts, affiliations] = await Promise.all([
      this.db<Record<string, string | number | null>[]>`
        SELECT
          COALESCE(SUM(CASE WHEN a.approval_status = 'approved'
            AND a.submitted_at::timestamptz >= ${start}::timestamptz
            AND a.submitted_at::timestamptz < ${before}::timestamptz
            THEN a.mileage_amount ELSE 0 END), 0)::text AS "accumulatedMileage",
          COALESCE(SUM(CASE WHEN a.approval_status = 'approved'
            AND (s.id IS NULL OR s.transfer_status = 'pending')
            AND a.decided_at::timestamptz < ${before}::timestamptz
            THEN a.mileage_amount ELSE 0 END), 0)::text AS "settlementMileage",
          COALESCE(SUM(CASE WHEN a.approval_status = 'approved'
            AND a.submitted_at::timestamptz >= ${start}::timestamptz
            AND a.submitted_at::timestamptz < ${before}::timestamptz
            THEN 1 ELSE 0 END), 0)::text AS "approvedCount",
          COALESCE(SUM(CASE WHEN a.approval_status = 'rejected'
            AND a.submitted_at::timestamptz >= ${start}::timestamptz
            AND a.submitted_at::timestamptz < ${before}::timestamptz
            THEN 1 ELSE 0 END), 0)::text AS "rejectedCount"
        FROM app.mileage_applications a
        LEFT JOIN app.settlements s ON s.id = a.settlement_id`,
      this.db<
        {
          date: string;
          common: string | number;
          affiliation: string | number;
        }[]
      >`
        SELECT (decided_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date::text AS date,
          SUM(mileage_amount)::text AS common,
          SUM(CASE WHEN logistics_company_id = ${companyId ?? ''} THEN mileage_amount ELSE 0 END)::text AS affiliation
        FROM app.mileage_applications
        WHERE approval_status = 'approved'
          AND decided_at::timestamptz >= ${start}::timestamptz
          AND decided_at::timestamptz < ${before}::timestamptz
        GROUP BY (decided_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date
        ORDER BY date`,
      this.db<
        {
          id: string;
          driverName: string;
          date: string;
          status: string;
          mileage: string | number | null;
        }[]
      >`
        SELECT a.id, u.name AS "driverName",
          (a.submitted_at::timestamptz AT TIME ZONE 'Asia/Seoul')::date::text AS date,
          a.approval_status AS status,
          CASE WHEN a.approval_status = 'approved' THEN a.mileage_amount::text END AS mileage
        FROM app.mileage_applications a JOIN app.users u ON u.id = a.user_id
        WHERE a.submitted_at::timestamptz >= ${start}::timestamptz
          AND a.submitted_at::timestamptz < ${before}::timestamptz
        ORDER BY a.submitted_at::timestamptz DESC, a.id DESC LIMIT 5`,
      this.db<{ value: string; label: string }[]>`
        SELECT id AS value, business_name AS label
        FROM app.logistics_companies ORDER BY business_name, id`,
    ]);
    const totals = totalsRows[0];
    return {
      accumulatedMileage: integer(totals.accumulatedMileage),
      settlementMileage: integer(totals.settlementMileage),
      approvedCount: integer(totals.approvedCount ?? 0),
      rejectedCount: integer(totals.rejectedCount ?? 0),
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
