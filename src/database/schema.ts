import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  phone: text('phone'),
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
  scopeUserId: text('scope_user_id').references(() => users.id, {
    onDelete: 'cascade',
  }),
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

export const installationSites = sqliteTable('installation_sites', {
  id: text('id').primaryKey(),
  pole: text('pole').notNull(),
  businessName: text('business_name').notNull(),
  roadAddress: text('road_address').notNull(),
  note: text('note'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  coordinateSource: text('coordinate_source'),
  coordinateVerifiedAt: text('coordinate_verified_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const installationSiteDevices = sqliteTable(
  'installation_site_devices',
  {
    id: text('id').primaryKey(),
    installationSiteId: text('installation_site_id')
      .notNull()
      .references(() => installationSites.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    capacityLiters: integer('capacity_liters').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
);

export const settlements = sqliteTable('settlements', {
  id: text('id').primaryKey(),
  logisticsCompanyId: text('logistics_company_id').notNull(),
  settlementMonth: text('settlement_month').notNull(),
  transferStatus: text('transfer_status', {
    enum: ['pending', 'completed'],
  }).notNull(),
  transferredAt: text('transferred_at'),
});

export const mileageApplications = sqliteTable('mileage_applications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  logisticsCompanyId: text('logistics_company_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash'),
  receiptAmount: integer('receipt_amount'),
  meterAmount: integer('meter_amount'),
  finalAmount: integer('final_amount'),
  mileageAmount: integer('mileage_amount'),
  receiptAt: text('receipt_at'),
  matchStatus: text('match_status', {
    enum: [
      'pending',
      'matched',
      'mismatched',
      'ocr_failed',
      'duplicate_suspected',
    ],
  })
    .notNull()
    .default('pending'),
  approvalStatus: text('approval_status', {
    enum: ['pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('pending'),
  rejectionReason: text('rejection_reason'),
  settlementId: text('settlement_id'),
  submittedAt: text('submitted_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  decidedAt: text('decided_at'),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const mileagePhotos = sqliteTable('mileage_application_photos', {
  id: text('id').primaryKey(),
  mileageApplicationId: text('mileage_application_id').notNull(),
  kind: text('kind', { enum: ['receipt', 'meter'] }).notNull(),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  originalStorageKey: text('original_storage_key'),
  originalContentType: text('original_content_type'),
  originalByteSize: integer('original_byte_size'),
});

export const mileageUploadAttempts = sqliteTable('mileage_upload_attempts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  storageKeys: text('storage_keys', { mode: 'json' })
    .$type<string[]>()
    .notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const mileageOcrJobs = sqliteTable('mileage_ocr_jobs', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => mileageApplications.id, { onDelete: 'cascade' }),
  sourceVersion: text('source_version').notNull(),
  extractorVersion: text('extractor_version').notNull(),
  status: text('status', {
    enum: ['queued', 'running', 'completed', 'failed', 'unknown'],
  })
    .notNull()
    .default('queued'),
  clovaReservedAt: text('clova_reserved_at'),
  lunaReservedAt: text('luna_reserved_at'),
  clovaDurationMs: integer('clova_duration_ms'),
  lunaDurationMs: integer('luna_duration_ms'),
  lunaInputTokens: integer('luna_input_tokens'),
  lunaOutputTokens: integer('luna_output_tokens'),
  result: text('result_json', { mode: 'json' }).$type<Record<
    string,
    unknown
  > | null>(),
  errorCode: text('error_code'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
});
