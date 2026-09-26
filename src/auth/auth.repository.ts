import { and, eq, gt, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { VerificationPurpose } from './phone-verification.dto';
import {
  authSessions,
  logisticsCompanies,
  phoneVerifications,
  passwordResetTokens,
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

type ResetEmailSession = {
  userId: string;
  tokenHash: string;
  now: Date;
  idleCutoff: Date;
};

type ResetEmailRecipient = {
  id: string;
  email: string;
  phone: string;
  passwordHash: string;
};

@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  findDriverCredentials(email: string) {
    return this.database.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          eq(users.email, email),
          eq(users.role, 'driver'),
          isNull(users.deactivatedAt),
        ),
      )
      .get();
  }

  findDriverPassword(userId: string) {
    return this.database.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.role, 'driver'),
          isNull(users.deactivatedAt),
        ),
      )
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
      transaction
        .update(passwordResetTokens)
        .set({ usedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(passwordResetTokens.userId, session.userId),
            isNull(passwordResetTokens.usedAt),
          ),
        )
        .run();
      return true;
    });
  }

  findPasswordReset(tokenHash: string) {
    return this.database.db
      .select({ userId: users.id, passwordHash: users.passwordHash })
      .from(passwordResetTokens)
      .innerJoin(users, eq(passwordResetTokens.userId, users.id))
      .innerJoin(
        logisticsCompanies,
        eq(users.logisticsCompanyId, logisticsCompanies.id),
      )
      .where(validPasswordReset(tokenHash))
      .get();
  }

  claimPasswordResetEmail(
    email: string,
    phone: string,
    proofHash: string,
    session?: ResetEmailSession,
  ): ResetEmailRecipient | undefined {
    return this.database.db.transaction(
      (transaction) => {
        const proof = transaction
          .update(phoneVerifications)
          .set({ consumedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(phoneVerifications.purpose, 'reset_password'),
              eq(phoneVerifications.scopeEmail, email.toLowerCase()),
              eq(phoneVerifications.phone, phone),
              eq(phoneVerifications.proofHash, proofHash),
              isNull(phoneVerifications.scopeUserId),
              isNotNull(phoneVerifications.verifiedAt),
              isNull(phoneVerifications.consumedAt),
              isNull(phoneVerifications.invalidatedAt),
              gt(phoneVerifications.expiresAt, sql`CURRENT_TIMESTAMP`),
            ),
          )
          .returning({ id: phoneVerifications.id })
          .get();
        if (!proof) throw new PhoneVerificationInvalidError();
        const candidate = transaction
          .select({
            id: users.id,
            email: users.email,
            passwordHash: users.passwordHash,
          })
          .from(users)
          .innerJoin(
            logisticsCompanies,
            eq(users.logisticsCompanyId, logisticsCompanies.id),
          )
          .where(
            and(
              eq(users.phone, phone),
              eq(users.role, 'driver'),
              isNull(users.deactivatedAt),
              eq(logisticsCompanies.active, true),
              session ? eq(users.id, session.userId) : undefined,
            ),
          )
          .get();
        // SMS와 같은 소문자 비교를 사용한다. SQLite NOCASE는 비ASCII 문자를 접지 못한다.
        // 고유 연락처로 한 계정만 조회하며 발송·재검사용 이메일은 DB 원문을 보존한다.
        const user =
          candidate?.email.toLowerCase() === email.toLowerCase()
            ? candidate
            : undefined;
        if (session) {
          const validSession = transaction
            .select({ id: users.id })
            .from(authSessions)
            .innerJoin(users, eq(authSessions.userId, users.id))
            .innerJoin(
              logisticsCompanies,
              eq(users.logisticsCompanyId, logisticsCompanies.id),
            )
            .where(
              and(
                validDriverSession(
                  session.tokenHash,
                  session.now,
                  session.idleCutoff,
                ),
                eq(users.id, session.userId),
              ),
            )
            .get();
          if (!validSession) throw new LoginUnavailableError();
          if (!user) throw new PhoneVerificationInvalidError();
        }
        // 계정 불일치도 증명은 소비하며 서비스가 조회 실패로 안내한다.
        if (user && user.passwordHash === null)
          throw new Error('Active driver password invariant violated');
        return user?.passwordHash
          ? { ...user, passwordHash: user.passwordHash, phone }
          : undefined;
      },
      { behavior: 'immediate' },
    );
  }

  activatePasswordResetEmail(
    recipient: ResetEmailRecipient,
    tokenHash: string,
    id: string,
    session?: ResetEmailSession,
  ): boolean {
    return this.database.db.transaction(
      (transaction) => {
        const user = transaction
          .select({ id: users.id })
          .from(users)
          .innerJoin(
            logisticsCompanies,
            eq(users.logisticsCompanyId, logisticsCompanies.id),
          )
          .where(
            and(
              eq(users.id, recipient.id),
              eq(users.email, recipient.email),
              eq(users.phone, recipient.phone),
              eq(users.passwordHash, recipient.passwordHash),
              eq(users.role, 'driver'),
              isNull(users.deactivatedAt),
              eq(logisticsCompanies.active, true),
            ),
          )
          .get();
        if (!user) return false;
        if (session) {
          const validSession = transaction
            .select({ id: users.id })
            .from(authSessions)
            .innerJoin(users, eq(authSessions.userId, users.id))
            .innerJoin(
              logisticsCompanies,
              eq(users.logisticsCompanyId, logisticsCompanies.id),
            )
            .where(
              and(
                validDriverSession(
                  session.tokenHash,
                  session.now,
                  session.idleCutoff,
                ),
                eq(users.id, session.userId),
              ),
            )
            .get();
          if (!validSession || session.userId !== recipient.id) return false;
        }
        // 메일 ACK 전에 토큰을 저장하지 않는다. 새 저장 실패 시 기존 링크 무효화도 롤백된다.
        transaction
          .update(passwordResetTokens)
          .set({ usedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(passwordResetTokens.userId, user.id),
              isNull(passwordResetTokens.usedAt),
            ),
          )
          .run();
        transaction
          .insert(passwordResetTokens)
          .values({
            id,
            userId: user.id,
            tokenHash,
            expiresAt: sql`datetime('now', '+30 minutes')`,
          })
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }

  resetDriverPassword(
    tokenHash: string,
    previousPasswordHash: string,
    passwordHash: string,
  ): boolean {
    return this.database.db.transaction((transaction) => {
      // 해시 생성 중 토큰 소비·만료 또는 계정 자격/비밀번호 변경을 다시 검사한다.
      const user = transaction
        .select({ id: users.id })
        .from(passwordResetTokens)
        .innerJoin(users, eq(passwordResetTokens.userId, users.id))
        .innerJoin(
          logisticsCompanies,
          eq(users.logisticsCompanyId, logisticsCompanies.id),
        )
        .where(
          and(
            validPasswordReset(tokenHash),
            eq(users.passwordHash, previousPasswordHash),
          ),
        )
        .get();
      if (!user) return false;
      transaction
        .update(users)
        .set({ passwordHash, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(users.id, user.id))
        .run();
      // 이전 비밀번호에 대한 다른 미사용 링크도 재사용할 수 없게 함께 소비한다.
      transaction
        .update(passwordResetTokens)
        .set({ usedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.usedAt),
          ),
        )
        .run();
      transaction
        .delete(authSessions)
        .where(eq(authSessions.userId, user.id))
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

  findEmailWithProof(phone: string, proofHash: string): string | undefined {
    return this.database.db.transaction(
      (transaction) => {
        const proof = transaction
          .update(phoneVerifications)
          .set({ consumedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(phoneVerifications.purpose, 'find_email'),
              eq(phoneVerifications.phone, phone),
              eq(phoneVerifications.proofHash, proofHash),
              isNull(phoneVerifications.scopeEmail),
              isNull(phoneVerifications.scopeUserId),
              isNotNull(phoneVerifications.verifiedAt),
              isNull(phoneVerifications.consumedAt),
              isNull(phoneVerifications.invalidatedAt),
              gt(phoneVerifications.expiresAt, sql`CURRENT_TIMESTAMP`),
            ),
          )
          .returning({ id: phoneVerifications.id })
          .get();
        if (!proof) throw new PhoneVerificationInvalidError();
        // 결과가 없어도 본인 확인 증명을 한 번 소비한다. DB 실패는 소비까지 롤백한다.
        return transaction
          .select({ email: users.email })
          .from(users)
          .where(
            and(
              eq(users.phone, phone),
              eq(users.role, 'driver'),
              isNull(users.deactivatedAt),
            ),
          )
          .get()?.email;
      },
      { behavior: 'immediate' },
    );
  }

  beginPhoneVerification(
    id: string,
    phone: string,
    codeHash: string,
    purpose: VerificationPurpose,
    email?: string,
    userId?: string,
  ): void {
    if (purpose === 'change_phone' && !userId)
      throw new Error('Phone change requires an owner');
    this.database.db.transaction((transaction) => {
      if (
        userId &&
        !transaction
          .select({ id: users.id })
          .from(users)
          .innerJoin(
            logisticsCompanies,
            eq(users.logisticsCompanyId, logisticsCompanies.id),
          )
          .where(
            and(
              eq(users.id, userId),
              eq(users.role, 'driver'),
              isNull(users.deactivatedAt),
              eq(logisticsCompanies.active, true),
            ),
          )
          .get()
      ) {
        throw new LoginUnavailableError();
      }
      transaction
        .update(phoneVerifications)
        .set({ invalidatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(phoneVerifications.purpose, purpose),
            purpose === 'change_phone'
              ? verificationOwner(userId)
              : eq(phoneVerifications.phone, phone),
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
          scopeUserId: userId,
          codeHash,
          // Pending sends use the epoch so a small clock rollback cannot enable them.
          expiresAt: '1970-01-01 00:00:00',
        })
        .run();
    });
  }

  activatePhoneVerification(
    id: string,
    purpose: VerificationPurpose,
    userId?: string,
  ): string | undefined {
    const verification = this.database.db
      .update(phoneVerifications)
      .set({ expiresAt: sql`datetime('now', '+3 minutes')` })
      .where(
        and(
          eq(phoneVerifications.id, id),
          eq(phoneVerifications.purpose, purpose),
          verificationOwner(userId),
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

  findActivePhoneVerification(
    id: string,
    purpose: VerificationPurpose,
    userId?: string,
  ) {
    return this.database.db
      .select({ codeHash: phoneVerifications.codeHash })
      .from(phoneVerifications)
      .where(validPhoneVerification(id, purpose, userId))
      .get();
  }

  confirmPhoneVerification(
    id: string,
    proofHash: string,
    purpose: VerificationPurpose,
    userId?: string,
  ): string | undefined {
    const verification = this.database.db
      .update(phoneVerifications)
      .set({ proofHash, verifiedAt: sql`CURRENT_TIMESTAMP` })
      .where(validPhoneVerification(id, purpose, userId))
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
      .where(and(eq(users.email, email), registeredIdentity()))
      .limit(1);

    if (emailDuplicate) {
      throw new EmailAlreadyExistsError();
    }

    const [phoneDuplicate] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, phone), registeredIdentity()))
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
          .where(and(eq(users.email, input.email), registeredIdentity()))
          .limit(1)
          .all();

        if (emailDuplicate) {
          throw new EmailAlreadyExistsError();
        }

        const [phoneDuplicate] = transaction
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.phone, input.phone), registeredIdentity()))
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

  changeDriverPhone(input: {
    userId: string;
    tokenHash: string;
    phone: string;
    proofHash: string;
    now: Date;
    idleCutoff: Date;
  }): boolean {
    try {
      return this.database.db.transaction((transaction) => {
        const session = transaction
          .select({ id: users.id })
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
            ),
          )
          .get();
        if (!session) return false;
        const proof = transaction
          .update(phoneVerifications)
          .set({ consumedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(phoneVerifications.purpose, 'change_phone'),
              eq(phoneVerifications.scopeUserId, input.userId),
              eq(phoneVerifications.phone, input.phone),
              eq(phoneVerifications.proofHash, input.proofHash),
              isNotNull(phoneVerifications.verifiedAt),
              isNull(phoneVerifications.invalidatedAt),
              isNull(phoneVerifications.consumedAt),
              gt(phoneVerifications.expiresAt, sql`CURRENT_TIMESTAMP`),
            ),
          )
          .returning({ id: phoneVerifications.id })
          .get();
        if (!proof) throw new PhoneVerificationInvalidError();
        const duplicate = transaction
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.phone, input.phone),
              ne(users.id, input.userId),
              registeredIdentity(),
            ),
          )
          .get();
        if (duplicate) throw new PhoneAlreadyExistsError();
        transaction
          .update(users)
          .set({ phone: input.phone, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(users.id, input.userId))
          .run();
        return true;
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

function registeredIdentity() {
  return or(isNull(users.deactivatedAt), eq(users.role, 'admin'));
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

function validPasswordReset(tokenHash: string) {
  return and(
    eq(passwordResetTokens.tokenHash, tokenHash),
    isNull(passwordResetTokens.usedAt),
    gt(sql`julianday(${passwordResetTokens.expiresAt})`, sql`julianday('now')`),
    eq(users.role, 'driver'),
    isNull(users.deactivatedAt),
    eq(logisticsCompanies.active, true),
  );
}

function validPhoneVerification(
  id: string,
  purpose: VerificationPurpose,
  userId?: string,
) {
  return and(
    eq(phoneVerifications.id, id),
    eq(phoneVerifications.purpose, purpose),
    verificationOwner(userId),
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

function verificationOwner(userId?: string) {
  return userId === undefined
    ? isNull(phoneVerifications.scopeUserId)
    : eq(phoneVerifications.scopeUserId, userId);
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
