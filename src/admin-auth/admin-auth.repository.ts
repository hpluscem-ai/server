import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { adminSessions, users } from '../database/schema';

@Injectable()
export class AdminAuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async findCredentials(email: string) {
    const [user] = await this.database.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = lower(${email})`,
          eq(users.role, 'admin'),
          isNull(users.deactivatedAt),
        ),
      );
    return user;
  }

  createSession(input: {
    userId: string;
    passwordHash: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<boolean> {
    return this.database.db.transaction(async (transaction) => {
      const [eligible] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, input.userId),
            eq(users.role, 'admin'),
            isNull(users.deactivatedAt),
            eq(users.passwordHash, input.passwordHash),
          ),
        )
        .for('update', { of: [users] });
      if (!eligible) return false;
      await transaction.insert(adminSessions).values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
      return true;
    });
  }

  async findSession(tokenHash: string) {
    const [session] = await this.database.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(adminSessions)
      .innerJoin(users, eq(adminSessions.userId, users.id))
      .where(
        and(
          eq(adminSessions.tokenHash, tokenHash),
          gt(adminSessions.expiresAt, new Date(Date.now())),
          eq(users.role, 'admin'),
          isNull(users.deactivatedAt),
        ),
      );
    return session;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.database.db.transaction(async (transaction) => {
      await transaction
        .delete(adminSessions)
        .where(eq(adminSessions.tokenHash, tokenHash));
    });
  }
}
