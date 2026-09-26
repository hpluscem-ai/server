import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  ilike,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import {
  adminSessions,
  authSessions,
  logisticsCompanies,
  passwordResetTokens,
  phoneVerifications,
  users,
} from '../database/schema';
import { AdminDriverListQueryDto } from './admin-driver.dto';

const profileFields = {
  email: users.email,
  name: users.name,
  phone: users.phone,
  marketingConsent: users.marketingConsent,
};

type ProfileChanges = { name?: string; marketingConsent?: boolean };

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  async findDrivers(query: AdminDriverListQueryDto) {
    return this.database.db
      .select({
        id: users.id,
        logisticsCompanyId: logisticsCompanies.id,
        logisticsCompanyName: logisticsCompanies.businessName,
        name: users.name,
        phone: users.phone,
        email: users.email,
        joinedAt: users.createdAt,
      })
      .from(users)
      .innerJoin(
        logisticsCompanies,
        eq(users.logisticsCompanyId, logisticsCompanies.id),
      )
      .where(
        and(
          eq(users.role, 'driver'),
          isNull(users.deactivatedAt),
          query.logisticsCompanyId
            ? eq(users.logisticsCompanyId, query.logisticsCompanyId)
            : undefined,
          query.createdFrom
            ? gte(
                sql`${users.createdAt}::timestamptz`,
                sql`${query.createdFrom}::timestamptz`,
              )
            : undefined,
          query.createdBefore
            ? lt(
                sql`${users.createdAt}::timestamptz`,
                sql`${query.createdBefore}::timestamptz`,
              )
            : undefined,
          query.nameQuery
            ? ilike(users.name, `%${escapeLike(query.nameQuery)}%`)
            : undefined,
        ),
      )
      .orderBy(desc(users.createdAt), asc(users.id));
  }

  async findProfile(userId: string) {
    const [profile] = await this.database.db
      .select(profileFields)
      .from(users)
      .where(this.activeDriver(userId))
      .limit(1);
    return profile;
  }

  async withdrawDriver(userId: string) {
    return this.database.db.transaction(async (tx) => {
      const [driver] = await tx
        .select({ email: users.email, phone: users.phone })
        .from(users)
        .where(
          and(
            eq(users.id, userId),
            eq(users.role, 'driver'),
            isNull(users.deactivatedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (!driver) return false;
      if (driver.phone === null)
        throw new Error('Driver phone invariant violated');

      await tx
        .update(users)
        .set({
          passwordHash: null,
          deactivatedAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(users.id, userId));
      await tx.delete(authSessions).where(eq(authSessions.userId, userId));
      await tx.delete(adminSessions).where(eq(adminSessions.userId, userId));
      await tx
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, userId));
      // Pending SMS sends are removed too, so a late provider response cannot revive them.
      await tx
        .delete(phoneVerifications)
        .where(
          or(
            eq(phoneVerifications.scopeUserId, userId),
            and(
              isNull(phoneVerifications.scopeUserId),
              or(
                eq(phoneVerifications.phone, driver.phone),
                and(
                  eq(phoneVerifications.purpose, 'reset_password'),
                  eq(phoneVerifications.scopeEmail, driver.email.toLowerCase()),
                ),
              ),
            ),
          ),
        );
      return true;
    });
  }

  async updateProfile(userId: string, changes: ProfileChanges) {
    // 한 UPDATE로 두 값을 함께 저장한다. 생략한 필드는 변경하지 않는다.
    const [profile] = await this.database.db
      .update(users)
      .set({
        name: changes.name,
        marketingConsent: changes.marketingConsent,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(this.activeDriver(userId))
      .returning(profileFields);
    return profile;
  }

  private activeDriver(userId: string) {
    return and(
      eq(users.id, userId),
      eq(users.role, 'driver'),
      isNull(users.deactivatedAt),
      inArray(
        users.logisticsCompanyId,
        this.database.db
          .select({ id: logisticsCompanies.id })
          .from(logisticsCompanies)
          .where(eq(logisticsCompanies.active, true)),
      ),
    );
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
