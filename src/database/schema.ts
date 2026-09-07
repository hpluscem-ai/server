import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Runtime query mappings only. schema.sql and numbered migrations own SQLite DDL.
export const logisticsCompanies = sqliteTable('logistics_companies', {
  id: text('id').primaryKey(),
  businessName: text('business_name').notNull(),
  businessNumber: text('business_number').notNull().unique(),
  corporateRegistrationNumber: text('corporate_registration_number')
    .notNull()
    .unique(),
  businessAddress: text('business_address').notNull(),
  managerName: text('manager_name').notNull(),
  managerPhone: text('manager_phone').notNull(),
  bankCode: text('bank_code').notNull(),
  accountNumber: text('account_number').notNull(),
  accountHolder: text('account_holder').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  phone: text('phone').unique(),
  logisticsCompanyId: text('logistics_company_id').references(
    () => logisticsCompanies.id,
    { onDelete: 'restrict' },
  ),
  serviceTermsConsent: integer('service_terms_consent', { mode: 'boolean' })
    .notNull()
    .default(false),
  privacyTermsConsent: integer('privacy_terms_consent', { mode: 'boolean' })
    .notNull()
    .default(false),
  marketingConsent: integer('marketing_consent', { mode: 'boolean' })
    .notNull()
    .default(false),
  deactivatedAt: text('deactivated_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const authSessions = sqliteTable('auth_sessions', {
  // 인증 토큰 원문이 아닌 SHA-256 해시이자 세션 식별자
  tokenHash: text('token_hash').primaryKey(),
  // 로그인한 사용자
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // 로그인한 시각: 최대 유지기간의 시작점
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  // 마지막 정상 인증 요청 시각: 미사용 기간의 시작점
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }).notNull(),
  // 활동 여부와 관계없이 만료되는 시각
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const adminSessions = sqliteTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const phoneVerifications = sqliteTable('phone_verifications', {
  id: text('id').primaryKey(),
  purpose: text('purpose').notNull(),
  phone: text('phone').notNull(),
  scopeEmail: text('scope_email'),
  codeHash: text('code_hash').notNull(),
  proofHash: text('proof_hash').unique(),
  expiresAt: text('expires_at').notNull(),
  verifiedAt: text('verified_at'),
  consumedAt: text('consumed_at'),
  invalidatedAt: text('invalidated_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const passwordResetTokens = sqliteTable('password_reset_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
