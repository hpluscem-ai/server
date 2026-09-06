import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { authSessions, logisticsCompanies, users } from '../database/schema';

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

  async findAllActiveForSignup() {
    return this.database.db
      .select({
        id: logisticsCompanies.id,
        businessName: logisticsCompanies.businessName,
      })
      .from(logisticsCompanies)
      .where(eq(logisticsCompanies.active, true))
      .orderBy(
        asc(logisticsCompanies.businessName),
        asc(logisticsCompanies.id),
      );
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

  deactivateActive(id: string): boolean {
    return this.database.db.transaction((transaction) => {
      const result = transaction
        .update(logisticsCompanies)
        .set({ active: false, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(logisticsCompanies.id, id),
            eq(logisticsCompanies.active, true),
          ),
        )
        .run();

      if (result.changes === 0) return false;

      // 소속 비활성화와 해당 기사들의 세션 폐기를 함께 확정하거나 함께 롤백한다.
      transaction
        .delete(authSessions)
        .where(
          inArray(
            authSessions.userId,
            transaction
              .select({ id: users.id })
              .from(users)
              .where(
                and(eq(users.logisticsCompanyId, id), eq(users.role, 'driver')),
              ),
          ),
        )
        .run();
      return true;
    });
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
