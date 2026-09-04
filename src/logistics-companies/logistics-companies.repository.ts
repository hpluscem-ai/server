import { and, asc, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { logisticsCompanies } from '../database/schema';

export class DuplicateLogisticsCompanyError extends Error {}

export type LogisticsCompanyRecord = typeof logisticsCompanies.$inferSelect;
type NewLogisticsCompany = Omit<
  typeof logisticsCompanies.$inferInsert,
  'active' | 'createdAt' | 'id' | 'updatedAt'
>;

@Injectable()
export class LogisticsCompaniesRepository {
  constructor(private readonly database: DatabaseService) {}

  async findAllActive(): Promise<LogisticsCompanyRecord[]> {
    const companies = await this.database.db
      .select()
      .from(logisticsCompanies)
      .where(eq(logisticsCompanies.active, true))
      .orderBy(
        asc(logisticsCompanies.businessName),
        asc(logisticsCompanies.id),
      );

    return companies.map(normalizeTimestamps);
  }

  async findActiveById(
    id: string,
  ): Promise<LogisticsCompanyRecord | undefined> {
    const [company] = await this.database.db
      .select()
      .from(logisticsCompanies)
      .where(
        and(eq(logisticsCompanies.id, id), eq(logisticsCompanies.active, true)),
      )
      .limit(1);

    return company ? normalizeTimestamps(company) : undefined;
  }

  async create(
    id: string,
    input: NewLogisticsCompany,
  ): Promise<LogisticsCompanyRecord> {
    try {
      const [company] = await this.database.db
        .insert(logisticsCompanies)
        .values({ id, ...input })
        .returning();

      return normalizeTimestamps(company);
    } catch (error) {
      this.throwIfDuplicate(error);
      throw error;
    }
  }

  async updateActive(
    id: string,
    input: NewLogisticsCompany,
  ): Promise<LogisticsCompanyRecord | undefined> {
    try {
      const [company] = await this.database.db
        .update(logisticsCompanies)
        .set({ ...input, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(logisticsCompanies.id, id),
            eq(logisticsCompanies.active, true),
          ),
        )
        .returning();

      return company ? normalizeTimestamps(company) : undefined;
    } catch (error) {
      this.throwIfDuplicate(error);
      throw error;
    }
  }

  async deactivateActive(id: string): Promise<boolean> {
    const result = await this.database.db
      .update(logisticsCompanies)
      .set({ active: false, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(logisticsCompanies.id, id), eq(logisticsCompanies.active, true)),
      );

    return result.changes > 0;
  }

  private throwIfDuplicate(error: unknown): void {
    const cause =
      typeof error === 'object' && error !== null && 'cause' in error
        ? error.cause
        : error;

    if (
      typeof cause === 'object' &&
      cause !== null &&
      (('errcode' in cause && cause.errcode === 2067) ||
        ('code' in cause && cause.code === '23505'))
    ) {
      throw new DuplicateLogisticsCompanyError();
    }
  }
}

function normalizeTimestamps(
  company: LogisticsCompanyRecord,
): LogisticsCompanyRecord {
  return {
    ...company,
    createdAt: `${company.createdAt.replace(' ', 'T')}Z`,
    updatedAt: `${company.updatedAt.replace(' ', 'T')}Z`,
  };
}
