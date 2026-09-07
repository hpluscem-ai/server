import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import { adminSessions, users } from '../database/schema';

@Injectable()
export class AdminAuthRepository {
  constructor(private readonly database: DatabaseService) {}

  findCredentials(email: string) {
    return this.database.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          eq(users.email, email),
          eq(users.role, 'admin'),
          isNull(users.deactivatedAt),
        ),
      )
      .get();
  }

  createSession(input: {
    userId: string;
    passwordHash: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): boolean {
    return this.database.db.transaction((transaction) => {
      const eligible = transaction
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
        .get();
      if (!eligible) return false;
      transaction
        .insert(adminSessions)
        .values({
          tokenHash: input.tokenHash,
          userId: input.userId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        })
        .run();
      return true;
    });
  }

  findSession(tokenHash: string) {
    return this.database.db
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
      )
      .get();
  }

  deleteSession(tokenHash: string): void {
    this.database.db.transaction((transaction) => {
      transaction
        .delete(adminSessions)
        .where(eq(adminSessions.tokenHash, tokenHash))
        .run();
    });
  }
}
