import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Runtime query mappings only. schema.sql remains the versioned SQLite DDL source.
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
