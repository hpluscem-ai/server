import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
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

  findDrivers(query: AdminDriverListQueryDto) {
    const rows = this.database.db
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
                sql`julianday(${users.createdAt})`,
                sql`julianday(${query.createdFrom})`,
              )
            : undefined,
          query.createdBefore
            ? lt(
                sql`julianday(${users.createdAt})`,
                sql`julianday(${query.createdBefore})`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(users.createdAt), asc(users.id))
      .all();
    // ponytail: Unicode contains search scans the selected rows; add indexed search when volume warrants it.
    const name = query.nameQuery?.toLocaleLowerCase('ko-KR');
    return name
      ? rows.filter((row) => row.name.toLocaleLowerCase('ko-KR').includes(name))
      : rows;
  }

  findProfile(userId: string) {
    return this.database.db
      .select(profileFields)
      .from(users)
      .where(this.activeDriver(userId))
      .get();
  }

  withdrawDriver(userId: string) {
    return this.database.db.transaction(
      (tx) => {
        const driver = tx
          .select({ email: users.email, phone: users.phone })
          .from(users)
          .where(
            and(
              eq(users.id, userId),
              eq(users.role, 'driver'),
              isNull(users.deactivatedAt),
            ),
          )
          .get();
        if (!driver) return false;
        if (driver.phone === null)
          throw new Error('Driver phone invariant violated');

        tx.update(users)
          .set({
            passwordHash: null,
            deactivatedAt: sql`CURRENT_TIMESTAMP`,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(users.id, userId))
          .run();
        tx.delete(authSessions).where(eq(authSessions.userId, userId)).run();
        tx.delete(adminSessions).where(eq(adminSessions.userId, userId)).run();
        tx.delete(passwordResetTokens)
          .where(eq(passwordResetTokens.userId, userId))
          .run();
        // Pending SMS sends are removed too, so a late provider response cannot revive them.
        tx.delete(phoneVerifications)
          .where(
            or(
              eq(phoneVerifications.scopeUserId, userId),
              and(
                isNull(phoneVerifications.scopeUserId),
                or(
                  eq(phoneVerifications.phone, driver.phone),
                  and(
                    eq(phoneVerifications.purpose, 'reset_password'),
                    eq(
                      phoneVerifications.scopeEmail,
                      driver.email.toLowerCase(),
                    ),
                  ),
                ),
              ),
            ),
          )
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  updateProfile(userId: string, changes: ProfileChanges) {
    // 한 UPDATE로 두 값을 함께 저장한다. 생략한 필드는 변경하지 않는다.
    return this.database.db
      .update(users)
      .set({
        name: changes.name,
        marketingConsent: changes.marketingConsent,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(this.activeDriver(userId))
      .returning(profileFields)
      .get();
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
