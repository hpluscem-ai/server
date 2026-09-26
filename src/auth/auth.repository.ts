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

type DriverCredentials = Pick<typeof users.$inferSelect, 'id' | 'passwordHash'>;
type DriverPassword = Pick<typeof users.$inferSelect, 'passwordHash'>;
type PasswordReset = { userId: string; passwordHash: string | null };
type SessionUser = {
  id: string;
  email: string;
  name: string;
  logisticsCompanyId: string;
};

@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async findDriverCredentials(
    email: string,
  ): Promise<DriverCredentials | undefined> {
    const [user] = await this.database.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          emailEquals(email),
          eq(users.role, 'driver'),
          isNull(users.deactivatedAt),
        ),
      );
    return user;
  }

  async findDriverPassword(
    userId: string,
  ): Promise<DriverPassword | undefined> {
    const [user] = await this.database.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.role, 'driver'),
          isNull(users.deactivatedAt),
        ),
      );
    return user;
  }

  changeDriverPassword(input: {
    userId: string;
    tokenHash: string;
    previousPasswordHash: string;
    passwordHash: string;
    now: Date;
    idleCutoff: Date;
  }): Promise<boolean> {
    return this.database.db.transaction(async (transaction) => {
      // Argon2를 기다리는 동안 폐기·만료·소속·자격·비밀번호가 바뀌었는지 다시 확인한다.
      const [session] = await transaction
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
        .for('update', { of: [users] });
      if (!session) return false;

      await transaction
        .update(users)
        .set({
          passwordHash: input.passwordHash,
          updatedAt: utcNow(),
        })
        .where(eq(users.id, session.userId));
      // 전체 기기의 세션 폐기가 실패하면 새 비밀번호 저장도 롤백한다.
      await transaction
        .delete(authSessions)
        .where(eq(authSessions.userId, session.userId));
      await transaction
        .update(passwordResetTokens)
        .set({ usedAt: utcNow() })
        .where(
          and(
            eq(passwordResetTokens.userId, session.userId),
            isNull(passwordResetTokens.usedAt),
          ),
        );
      return true;
    });
  }

  async findPasswordReset(
    tokenHash: string,
  ): Promise<PasswordReset | undefined> {
    const [reset] = await this.database.db
      .select({ userId: users.id, passwordHash: users.passwordHash })
      .from(passwordResetTokens)
      .innerJoin(users, eq(passwordResetTokens.userId, users.id))
      .innerJoin(
        logisticsCompanies,
        eq(users.logisticsCompanyId, logisticsCompanies.id),
      )
      .where(validPasswordReset(tokenHash));
    return reset;
  }

  claimPasswordResetEmail(
    email: string,
    phone: string,
    proofHash: string,
    session?: ResetEmailSession,
  ): Promise<ResetEmailRecipient | undefined> {
    return this.database.db.transaction(async (transaction) => {
      const [proof] = await transaction
        .update(phoneVerifications)
        .set({ consumedAt: utcNow() })
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
            isFuture(phoneVerifications.expiresAt),
          ),
        )
        .returning({ id: phoneVerifications.id });
      if (!proof) throw new PhoneVerificationInvalidError();
      const [candidate] = await transaction
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
        );
      // SMS와 같은 소문자 비교를 사용한다. SQLite NOCASE는 비ASCII 문자를 접지 못한다.
      // 고유 연락처로 한 계정만 조회하며 발송·재검사용 이메일은 DB 원문을 보존한다.
      const user =
        candidate?.email.toLowerCase() === email.toLowerCase()
          ? candidate
          : undefined;
      if (session) {
        const [validSession] = await transaction
          .select({ id: users.id })
          .from(authSessions)
          .innerJoin(users, eq(authSessions.userId, users.id))
          .innerJoin(
            logisticsCompanies,
            eq(users.logisticsCompanyId, logisticsCompanies.id),
          )
          .for('update', { of: [authSessions] })
          .where(
            and(
              validDriverSession(
                session.tokenHash,
                session.now,
                session.idleCutoff,
              ),
              eq(users.id, session.userId),
            ),
          );
        if (!validSession) throw new LoginUnavailableError();
        if (!user) throw new PhoneVerificationInvalidError();
      }
      // 계정 불일치도 증명은 소비하며 서비스가 조회 실패로 안내한다.
      if (user && user.passwordHash === null)
        throw new Error('Active driver password invariant violated');
      return user?.passwordHash
        ? { ...user, passwordHash: user.passwordHash, phone }
        : undefined;
    });
  }

  activatePasswordResetEmail(
    recipient: ResetEmailRecipient,
    tokenHash: string,
    id: string,
    session?: ResetEmailSession,
  ): Promise<boolean> {
    return this.database.db.transaction(async (transaction) => {
      const [user] = await transaction
        .select({ id: users.id })
        .from(users)
        .innerJoin(
          logisticsCompanies,
          eq(users.logisticsCompanyId, logisticsCompanies.id),
        )
        .where(
          and(
            eq(users.id, recipient.id),
            emailEquals(recipient.email),
            eq(users.phone, recipient.phone),
            eq(users.passwordHash, recipient.passwordHash),
            eq(users.role, 'driver'),
            isNull(users.deactivatedAt),
            eq(logisticsCompanies.active, true),
          ),
        )
        .for('update', { of: [users] });
      if (!user) return false;
      if (session) {
        const [validSession] = await transaction
          .select({ id: users.id })
          .from(authSessions)
          .innerJoin(users, eq(authSessions.userId, users.id))
          .innerJoin(
            logisticsCompanies,
            eq(users.logisticsCompanyId, logisticsCompanies.id),
          )
          .for('update', { of: [authSessions] })
          .where(
            and(
              validDriverSession(
                session.tokenHash,
                session.now,
                session.idleCutoff,
              ),
              eq(users.id, session.userId),
            ),
          );
        if (!validSession || session.userId !== recipient.id) return false;
      }
      // 메일 ACK 전에 토큰을 저장하지 않는다. 새 저장 실패 시 기존 링크 무효화도 롤백된다.
      await transaction
        .update(passwordResetTokens)
        .set({ usedAt: utcNow() })
        .where(
          and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.usedAt),
          ),
        );
      await transaction.insert(passwordResetTokens).values({
        id,
        userId: user.id,
        tokenHash,
        expiresAt: utcFuture('30 minutes'),
      });
      return true;
    });
  }

  resetDriverPassword(
    tokenHash: string,
    previousPasswordHash: string,
    passwordHash: string,
  ): Promise<boolean> {
    return this.database.db.transaction(async (transaction) => {
      // 해시 생성 중 토큰 소비·만료 또는 계정 자격/비밀번호 변경을 다시 검사한다.
      const [user] = await transaction
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
        .for('update', { of: [users] });
      if (!user) return false;
      await transaction
        .update(users)
        .set({ passwordHash, updatedAt: utcNow() })
        .where(eq(users.id, user.id));
      // 이전 비밀번호에 대한 다른 미사용 링크도 재사용할 수 없게 함께 소비한다.
      await transaction
        .update(passwordResetTokens)
        .set({ usedAt: utcNow() })
        .where(
          and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.usedAt),
          ),
        );
      await transaction
        .delete(authSessions)
        .where(eq(authSessions.userId, user.id));
      return true;
    });
  }

  async createLoginSession(input: CreateLoginSessionInput): Promise<void> {
    await this.database.db.transaction(async (transaction) => {
      // 비밀번호 검증을 기다리는 동안 계정·소속·비밀번호가 바뀔 수 있어 다시 확인한다.
      const [user] = await transaction
        .select({
          passwordHash: users.passwordHash,
          logisticsCompanyId: users.logisticsCompanyId,
        })
        .from(users)
        .where(
          and(
            eq(users.id, input.userId),
            eq(users.role, 'driver'),
            isNull(users.deactivatedAt),
          ),
        )
        .for('update', { of: [users] });

      if (
        !user ||
        !user.logisticsCompanyId ||
        user.passwordHash !== input.passwordHash
      ) {
        throw new LoginUnavailableError();
      }

      const [company] = await transaction
        .select({ id: logisticsCompanies.id })
        .from(logisticsCompanies)
        .where(
          and(
            eq(logisticsCompanies.id, user.logisticsCompanyId),
            eq(logisticsCompanies.active, true),
          ),
        )
        .for('update', { of: [logisticsCompanies] });
      if (!company) throw new LoginUnavailableError();

      await transaction.insert(authSessions).values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        createdAt: input.createdAt,
        lastUsedAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
    });
  }

  async useSession(
    tokenHash: string,
    now: Date,
    idleCutoff: Date,
  ): Promise<SessionUser | undefined> {
    return this.database.db.transaction(async (transaction) => {
      const [session] = await transaction
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
        .for('update', { of: [authSessions] });

      if (!session) {
        await transaction
          .delete(authSessions)
          .where(eq(authSessions.tokenHash, tokenHash));
        return undefined;
      }

      await transaction
        .update(authSessions)
        .set({
          // 시계가 되돌아가도 마지막 사용 시각은 감소시키지 않는다.
          lastUsedAt: new Date(
            Math.max(now.getTime(), session.lastUsedAt.getTime()),
          ),
        })
        .where(eq(authSessions.tokenHash, tokenHash));
      return session.user;
    });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.database.db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, tokenHash));
  }

  async findEmailWithProof(
    phone: string,
    proofHash: string,
  ): Promise<string | undefined> {
    return this.database.db.transaction(async (transaction) => {
      const [proof] = await transaction
        .update(phoneVerifications)
        .set({ consumedAt: utcNow() })
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
            isFuture(phoneVerifications.expiresAt),
          ),
        )
        .returning({ id: phoneVerifications.id });
      if (!proof) throw new PhoneVerificationInvalidError();
      // 결과가 없어도 본인 확인 증명을 한 번 소비한다. DB 실패는 소비까지 롤백한다.
      const [user] = await transaction
        .select({ email: users.email })
        .from(users)
        .where(
          and(
            eq(users.phone, phone),
            eq(users.role, 'driver'),
            isNull(users.deactivatedAt),
          ),
        );
      return user?.email;
    });
  }

  beginPhoneVerification(
    id: string,
    phone: string,
    codeHash: string,
    purpose: VerificationPurpose,
    email?: string,
    userId?: string,
  ): Promise<void> {
    if (purpose === 'change_phone' && !userId)
      throw new Error('Phone change requires an owner');
    return this.database.db.transaction(async (transaction) => {
      // UPDATE가 아직 없는 범위도 동시에 시작될 수 있으므로, 무효화 범위를
      // 트랜잭션 수명 동안 잠근다. 외부 SMS 호출은 이 트랜잭션 밖에서 한다.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${purpose}), hashtext(${phoneVerificationScope(phone, userId)}))`,
      );
      const [owner] = userId
        ? await transaction
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
            .for('update', { of: [users] })
        : [];
      if (userId && !owner) {
        throw new LoginUnavailableError();
      }
      await transaction
        .update(phoneVerifications)
        .set({ invalidatedAt: utcNow() })
        .where(
          and(
            eq(phoneVerifications.purpose, purpose),
            purpose === 'change_phone'
              ? verificationOwner(userId)
              : eq(phoneVerifications.phone, phone),
            isNull(phoneVerifications.consumedAt),
            isNull(phoneVerifications.invalidatedAt),
          ),
        );

      await transaction.insert(phoneVerifications).values({
        id,
        phone,
        purpose,
        scopeEmail: email,
        scopeUserId: userId,
        codeHash,
        // Pending sends use the epoch so a small clock rollback cannot enable them.
        expiresAt: '1970-01-01 00:00:00',
      });
    });
  }

  async activatePhoneVerification(
    id: string,
    purpose: VerificationPurpose,
    userId?: string,
  ): Promise<string | undefined> {
    const [verification] = await this.database.db
      .update(phoneVerifications)
      .set({ expiresAt: utcFuture('3 minutes') })
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
      .returning({ expiresAt: phoneVerifications.expiresAt });

    return verification ? isoUtc(verification.expiresAt) : undefined;
  }

  async findActivePhoneVerification(
    id: string,
    purpose: VerificationPurpose,
    userId?: string,
  ): Promise<{ codeHash: string } | undefined> {
    const [verification] = await this.database.db
      .select({ codeHash: phoneVerifications.codeHash })
      .from(phoneVerifications)
      .where(validPhoneVerification(id, purpose, userId));
    return verification;
  }

  async confirmPhoneVerification(
    id: string,
    proofHash: string,
    purpose: VerificationPurpose,
    userId?: string,
  ): Promise<string | undefined> {
    const [verification] = await this.database.db
      .update(phoneVerifications)
      .set({ proofHash, verifiedAt: utcNow() })
      .where(validPhoneVerification(id, purpose, userId))
      .returning({ expiresAt: phoneVerifications.expiresAt });

    return verification ? isoUtc(verification.expiresAt) : undefined;
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
      .where(and(emailEquals(email), registeredIdentity()))
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

  async createDriver(input: CreateDriverInput): Promise<string> {
    try {
      return await this.database.db.transaction(async (transaction) => {
        const [verification] = await transaction
          .update(phoneVerifications)
          .set({ consumedAt: utcNow() })
          .where(validSignUpProof(input.phone, input.proofHash))
          .returning({ id: phoneVerifications.id });

        if (!verification) {
          throw new PhoneVerificationInvalidError();
        }

        const [company] = await transaction
          .select({ id: logisticsCompanies.id })
          .from(logisticsCompanies)
          .where(
            and(
              eq(logisticsCompanies.id, input.logisticsCompanyId),
              eq(logisticsCompanies.active, true),
            ),
          )
          .for('update', { of: [logisticsCompanies] })
          .limit(1);

        if (!company) {
          throw new LogisticsCompanyUnavailableError();
        }

        const [emailDuplicate] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(and(emailEquals(input.email), registeredIdentity()))
          .limit(1);

        if (emailDuplicate) {
          throw new EmailAlreadyExistsError();
        }

        const [phoneDuplicate] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.phone, input.phone), registeredIdentity()))
          .limit(1);

        if (phoneDuplicate) {
          throw new PhoneAlreadyExistsError();
        }

        const [user] = await transaction
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
          .returning({ id: users.id });

        return user.id;
      });
    } catch (error) {
      this.throwIfDuplicate(error);
      throw error;
    }
  }

  async changeDriverPhone(input: {
    userId: string;
    tokenHash: string;
    phone: string;
    proofHash: string;
    now: Date;
    idleCutoff: Date;
  }): Promise<boolean> {
    try {
      return await this.database.db.transaction(async (transaction) => {
        const [session] = await transaction
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
          .for('update', { of: [users] });
        if (!session) return false;
        const [proof] = await transaction
          .update(phoneVerifications)
          .set({ consumedAt: utcNow() })
          .where(
            and(
              eq(phoneVerifications.purpose, 'change_phone'),
              eq(phoneVerifications.scopeUserId, input.userId),
              eq(phoneVerifications.phone, input.phone),
              eq(phoneVerifications.proofHash, input.proofHash),
              isNotNull(phoneVerifications.verifiedAt),
              isNull(phoneVerifications.invalidatedAt),
              isNull(phoneVerifications.consumedAt),
              isFuture(phoneVerifications.expiresAt),
            ),
          )
          .returning({ id: phoneVerifications.id });
        if (!proof) throw new PhoneVerificationInvalidError();
        const [duplicate] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.phone, input.phone),
              ne(users.id, input.userId),
              registeredIdentity(),
            ),
          );
        if (duplicate) throw new PhoneAlreadyExistsError();
        await transaction
          .update(users)
          .set({ phone: input.phone, updatedAt: utcNow() })
          .where(eq(users.id, input.userId));
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
    const constraint =
      typeof cause === 'object' && cause !== null && 'constraint' in cause
        ? String(cause.constraint)
        : '';

    if (!isUniqueConstraintError(cause)) {
      return;
    }

    if (
      message.includes('users.email') ||
      constraint === 'users_registered_email_idx'
    ) {
      throw new EmailAlreadyExistsError();
    }

    if (
      message.includes('users.phone') ||
      constraint === 'users_registered_phone_idx'
    ) {
      throw new PhoneAlreadyExistsError();
    }
  }
}

function registeredIdentity() {
  return or(isNull(users.deactivatedAt), eq(users.role, 'admin'));
}

function emailEquals(email: string) {
  return sql`lower(${users.email}) = lower(${email})`;
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
    isFuture(passwordResetTokens.expiresAt),
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
    isFuture(phoneVerifications.expiresAt),
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
    isFuture(phoneVerifications.expiresAt),
  );
}

function verificationOwner(userId?: string) {
  return userId === undefined
    ? isNull(phoneVerifications.scopeUserId)
    : eq(phoneVerifications.scopeUserId, userId);
}

function phoneVerificationScope(phone: string, userId?: string): string {
  return userId === undefined ? `phone:${phone}` : `user:${userId}`;
}

function utcNow() {
  return sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function utcFuture(interval: string) {
  return sql`to_char((CURRENT_TIMESTAMP + ${sql.raw(`INTERVAL '${interval}'`)}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function isFuture(
  value:
    typeof passwordResetTokens.expiresAt | typeof phoneVerifications.expiresAt,
) {
  return sql`(${value}::timestamp AT TIME ZONE 'UTC') > CURRENT_TIMESTAMP`;
}

function isoUtc(value: string): string {
  return value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`;
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
