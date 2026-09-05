import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import {
  logisticsCompanies,
  phoneVerifications,
  users,
} from '../database/schema';

export class EmailAlreadyExistsError extends Error {}
export class LogisticsCompanyUnavailableError extends Error {}
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

@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  beginPhoneVerification(id: string, phone: string, codeHash: string): void {
    this.database.db.transaction((transaction) => {
      transaction
        .update(phoneVerifications)
        .set({ invalidatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(phoneVerifications.purpose, 'sign_up'),
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
          purpose: 'sign_up',
          codeHash,
          // Pending sends use the epoch so a small clock rollback cannot enable them.
          expiresAt: '1970-01-01 00:00:00',
        })
        .run();
    });
  }

  activatePhoneVerification(id: string): string | undefined {
    const verification = this.database.db
      .update(phoneVerifications)
      .set({ expiresAt: sql`datetime('now', '+3 minutes')` })
      .where(
        and(
          eq(phoneVerifications.id, id),
          eq(phoneVerifications.purpose, 'sign_up'),
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

  findPendingPhoneVerification(id: string) {
    return this.database.db
      .select({ codeHash: phoneVerifications.codeHash })
      .from(phoneVerifications)
      .where(validPendingPhoneVerification(id))
      .get();
  }

  confirmPhoneVerification(id: string, proofHash: string): string | undefined {
    const verification = this.database.db
      .update(phoneVerifications)
      .set({ proofHash, verifiedAt: sql`CURRENT_TIMESTAMP` })
      .where(validPendingPhoneVerification(id))
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

function validPendingPhoneVerification(id: string) {
  return and(
    eq(phoneVerifications.id, id),
    eq(phoneVerifications.purpose, 'sign_up'),
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
