import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { logisticsCompanies, users } from '../database/schema';
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
