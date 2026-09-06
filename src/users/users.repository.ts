import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { logisticsCompanies, users } from '../database/schema';

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
