import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { PublicVerificationPurpose } from './phone-verification.dto';
import {
  authSessions,
  logisticsCompanies,
  phoneVerifications,
  users,
} from '../database/schema';

export class EmailAlreadyExistsError extends Error {}
export class LogisticsCompanyUnavailableError extends Error {}
export class LoginUnavailableError extends Error {}
export class PhoneAlreadyExistsError extends Error {}
export class PhoneVerificationInvalidError extends Error {}

type CreateDriverInput = {
  email: string;
  id: string;
  logisticsCompanyId: string;
  marketingTerms: boolean;
  name: string;
  passwordHash: string;
  phone: string;
  privacyTerms: boolean;
  proofHash: string;
  serviceTerms: boolean;
};

type CreateLoginSessionInput = {
  userId: string;
  passwordHash: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
};

@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  findDriverCredentials(email: string) {
    return this.database.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.email, email), eq(users.role, 'driver')))
      .get();
  }

  findDriverPassword(userId: string) {
    return this.database.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.role, 'driver')))
      .get();
  }

  changeDriverPassword(input: {
    userId: string;
    tokenHash: string;
    previousPasswordHash: string;
    passwordHash: string;
    now: Date;
    idleCutoff: Date;
  }): boolean {
    return this.database.db.transaction((transaction) => {
      // Argon2를 기다리는 동안 폐기·만료·소속·자격·비밀번호가 바뀌었는지 다시 확인한다.
      const session = transaction
        .select({ userId: users.id })
        .from(authSessions)
        .innerJoin(users, eq(authSessions.userId, users.id))
        .innerJoin(
          logisticsCompanies,
          eq(users.logisticsCompanyId, logisticsCompanies.id),
        )
        .where(
          and(
            validDriverSession(input.tokenHash, input.now, input.idleCutoff),
            eq(users.id, input.userId),
            eq(users.passwordHash, input.previousPasswordHash),
          ),
        )
        .get();
      if (!session) return false;

      transaction
        .update(users)
        .set({
          passwordHash: input.passwordHash,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(users.id, session.userId))
        .run();
      // 전체 기기의 세션 폐기가 실패하면 새 비밀번호 저장도 롤백한다.
      transaction
        .delete(authSessions)
        .where(eq(authSessions.userId, session.userId))
        .run();
      return true;
    });
  }

  createLoginSession(input: CreateLoginSessionInput): void {
    this.database.db.transaction((transaction) => {
      // 비밀번호 검증을 기다리는 동안 계정·소속·비밀번호가 바뀔 수 있어 다시 확인한다.
      const user = transaction
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .innerJoin(
          logisticsCompanies,
          eq(users.logisticsCompanyId, logisticsCompanies.id),
        )
        .where(
          and(
            eq(users.id, input.userId),
            eq(users.role, 'driver'),
            isNull(users.deactivatedAt),
            eq(logisticsCompanies.active, true),
          ),
        )
        .get();

      if (!user || user.passwordHash !== input.passwordHash) {
        throw new LoginUnavailableError();
      }

      transaction
        .insert(authSessions)
        .values({
          tokenHash: input.tokenHash,
          userId: input.userId,
          createdAt: input.createdAt,
          lastUsedAt: input.createdAt,
          expiresAt: input.expiresAt,
        })
        .run();
    });
  }

  useSession(tokenHash: string, now: Date, idleCutoff: Date) {
    return this.database.db.transaction((transaction) => {
      const session = transaction
        .select({
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            logisticsCompanyId: logisticsCompanies.id,
          },
          lastUsedAt: authSessions.lastUsedAt,
        })
        .from(authSessions)
        .innerJoin(users, eq(authSessions.userId, users.id))
        .innerJoin(
          logisticsCompanies,
          eq(users.logisticsCompanyId, logisticsCompanies.id),
        )
        .where(validDriverSession(tokenHash, now, idleCutoff))
        .get();

      if (!session) {
        transaction
          .delete(authSessions)
          .where(eq(authSessions.tokenHash, tokenHash))
          .run();
        return undefined;
      }

      transaction
        .update(authSessions)
        .set({
          // 시계가 되돌아가도 마지막 사용 시각은 감소시키지 않는다.
          lastUsedAt: new Date(
            Math.max(now.getTime(), session.lastUsedAt.getTime()),
          ),
        })
        .where(eq(authSessions.tokenHash, tokenHash))
        .run();
      return session.user;
    });
  }

  deleteSession(tokenHash: string): void {
    this.database.db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, tokenHash))
      .run();
  }

  beginPhoneVerification(
    id: string,
    phone: string,
    codeHash: string,
    purpose: PublicVerificationPurpose,
    email?: string,
  ): void {
    this.database.db.transaction((transaction) => {
      transaction
        .update(phoneVerifications)
        .set({ invalidatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(phoneVerifications.purpose, purpose),
            eq(phoneVerifications.phone, phone),
            isNull(phoneVerifications.consumedAt),
            isNull(phoneVerifications.invalidatedAt),
          ),
        )
        .run();

      transaction
        .insert(phoneVerifications)
        .values({
          id,
          phone,
          purpose,
          scopeEmail: email,
          codeHash,
          // Pending sends use the epoch so a small clock rollback cannot enable them.
          expiresAt: '1970-01-01 00:00:00',
        })
        .run();
    });
  }

  activatePhoneVerification(
    id: string,
    purpose: PublicVerificationPurpose,
  ): string | undefined {
    const verification = this.database.db
      .update(phoneVerifications)
      .set({ expiresAt: sql`datetime('now', '+3 minutes')` })
      .where(
        and(
          eq(phoneVerifications.id, id),
          eq(phoneVerifications.purpose, purpose),
          isNull(phoneVerifications.invalidatedAt),
          isNull(phoneVerifications.verifiedAt),
          isNull(phoneVerifications.consumedAt),
        ),
      )
      .returning({ expiresAt: phoneVerifications.expiresAt })
      .get();

    return verification
      ? `${verification.expiresAt.replace(' ', 'T')}Z`
      : undefined;
  }

  findPendingPhoneVerification(id: string, purpose: PublicVerificationPurpose) {
    return this.database.db
      .select({ codeHash: phoneVerifications.codeHash })
      .from(phoneVerifications)
      .where(validPendingPhoneVerification(id, purpose))
      .get();
  }

  confirmPhoneVerification(
    id: string,
    proofHash: string,
    purpose: PublicVerificationPurpose,
  ): string | undefined {
    const verification = this.database.db
      .update(phoneVerifications)
      .set({ proofHash, verifiedAt: sql`CURRENT_TIMESTAMP` })
      .where(validPendingPhoneVerification(id, purpose))
      .returning({ expiresAt: phoneVerifications.expiresAt })
      .get();

    return verification
      ? `${verification.expiresAt.replace(' ', 'T')}Z`
      : undefined;
  }

  async assertSignUpPrerequisites(
    email: string,
    logisticsCompanyId: string,
    phone: string,
    proofHash: string,
  ): Promise<void> {
    const [verification] = await this.database.db
      .select({ id: phoneVerifications.id })
      .from(phoneVerifications)
      .where(validSignUpProof(phone, proofHash))
      .limit(1);

    if (!verification) {
      throw new PhoneVerificationInvalidError();
    }

    const [company] = await this.database.db
      .select({ id: logisticsCompanies.id })
      .from(logisticsCompanies)
      .where(
        and(
          eq(logisticsCompanies.id, logisticsCompanyId),
          eq(logisticsCompanies.active, true),
        ),
      )
      .limit(1);

    if (!company) {
      throw new LogisticsCompanyUnavailableError();
    }

    const [emailDuplicate] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (emailDuplicate) {
      throw new EmailAlreadyExistsError();
    }

    const [phoneDuplicate] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, phone))
      .limit(1);

    if (phoneDuplicate) {
      throw new PhoneAlreadyExistsError();
    }
  }

  createDriver(input: CreateDriverInput): string {
    try {
      return this.database.db.transaction((transaction) => {
        const [verification] = transaction
          .update(phoneVerifications)
          .set({ consumedAt: sql`CURRENT_TIMESTAMP` })
          .where(validSignUpProof(input.phone, input.proofHash))
          .returning({ id: phoneVerifications.id })
          .all();

        if (!verification) {
          throw new PhoneVerificationInvalidError();
        }

        const [company] = transaction
          .select({ id: logisticsCompanies.id })
          .from(logisticsCompanies)
          .where(
            and(
              eq(logisticsCompanies.id, input.logisticsCompanyId),
              eq(logisticsCompanies.active, true),
            ),
          )
          .limit(1)
          .all();

        if (!company) {
          throw new LogisticsCompanyUnavailableError();
        }

        const [emailDuplicate] = transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1)
          .all();

        if (emailDuplicate) {
          throw new EmailAlreadyExistsError();
        }

        const [phoneDuplicate] = transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.phone, input.phone))
          .limit(1)
          .all();

        if (phoneDuplicate) {
          throw new PhoneAlreadyExistsError();
        }

        const [user] = transaction
          .insert(users)
          .values({
            email: input.email,
            id: input.id,
            logisticsCompanyId: input.logisticsCompanyId,
            marketingConsent: input.marketingTerms,
            name: input.name,
            passwordHash: input.passwordHash,
            phone: input.phone,
            privacyTermsConsent: input.privacyTerms,
            role: 'driver',
            serviceTermsConsent: input.serviceTerms,
          })
          .returning({ id: users.id })
          .all();

        return user.id;
      });
    } catch (error) {
      this.throwIfDuplicate(error);
      throw error;
    }
  }

  private throwIfDuplicate(error: unknown): void {
    const cause = getDatabaseCause(error);
    const message =
      typeof cause === 'object' && cause !== null && 'message' in cause
        ? String(cause.message)
        : '';

    if (!isUniqueConstraintError(cause)) {
      return;
    }

    if (message.includes('users.email')) {
      throw new EmailAlreadyExistsError();
    }

    if (message.includes('users.phone')) {
      throw new PhoneAlreadyExistsError();
    }
  }
}

function validDriverSession(tokenHash: string, now: Date, idleCutoff: Date) {
  return and(
    eq(authSessions.tokenHash, tokenHash),
    gt(authSessions.expiresAt, now),
    gt(authSessions.lastUsedAt, idleCutoff),
    eq(users.role, 'driver'),
    isNull(users.deactivatedAt),
    eq(logisticsCompanies.active, true),
  );
}

function validPendingPhoneVerification(
  id: string,
  purpose: PublicVerificationPurpose,
) {
  return and(
    eq(phoneVerifications.id, id),
    eq(phoneVerifications.purpose, purpose),
    isNull(phoneVerifications.verifiedAt),
    isNull(phoneVerifications.consumedAt),
    isNull(phoneVerifications.invalidatedAt),
    gt(phoneVerifications.expiresAt, sql`CURRENT_TIMESTAMP`),
  );
}

function validSignUpProof(phone: string, proofHash: string) {
  return and(
    eq(phoneVerifications.purpose, 'sign_up'),
    eq(phoneVerifications.phone, phone),
    eq(phoneVerifications.proofHash, proofHash),
    isNotNull(phoneVerifications.verifiedAt),
    isNull(phoneVerifications.consumedAt),
    isNull(phoneVerifications.invalidatedAt),
    gt(phoneVerifications.expiresAt, sql`CURRENT_TIMESTAMP`),
  );
}

function getDatabaseCause(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error
    ? error.cause
    : error;
}

function isUniqueConstraintError(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (('errcode' in cause && cause.errcode === 2067) ||
      ('code' in cause && cause.code === '23505'))
  );
}
