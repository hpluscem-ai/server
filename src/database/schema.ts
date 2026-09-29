import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// Application data stays outside Supabase's exposed public schema.
export const appSchema = pgSchema('app');

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);
const updatedAt = () =>
  text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);
const money = (name: string) => bigint(name, { mode: 'number' });

export const logisticsCompanies = appSchema.table('logistics_companies', {
  id: text('id').primaryKey(),
  businessName: text('business_name').notNull(),
  businessNumber: text('business_number').notNull(),
  corporateRegistrationNumber: text('corporate_registration_number').notNull(),
  businessAddress: text('business_address').notNull(),
  managerName: text('manager_name').notNull(),
  managerPhone: text('manager_phone').notNull(),
  bankCode: text('bank_code').notNull(),
  accountNumber: text('account_number').notNull(),
  accountHolder: text('account_holder').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = appSchema.table('users', {
  id: text('id').primaryKey(),
  role: text('role', { enum: ['admin', 'driver'] }).notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  name: text('name').notNull(),
  phone: text('phone'),
  logisticsCompanyId: text('logistics_company_id').references(
    () => logisticsCompanies.id,
    { onDelete: 'restrict' },
  ),
  serviceTermsConsent: boolean('service_terms_consent')
    .notNull()
    .default(false),
  privacyTermsConsent: boolean('privacy_terms_consent')
    .notNull()
    .default(false),
  marketingConsent: boolean('marketing_consent').notNull().default(false),
  deactivatedAt: text('deactivated_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSessions = appSchema.table('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
  lastUsedAt: timestamp('last_used_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

export const adminSessions = appSchema.table('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

export const phoneVerifications = appSchema.table('phone_verifications', {
  id: text('id').primaryKey(),
  purpose: text('purpose', {
    enum: ['sign_up', 'find_email', 'reset_password', 'change_phone'],
  }).notNull(),
  phone: text('phone').notNull(),
  scopeEmail: text('scope_email'),
  scopeUserId: text('scope_user_id').references(() => users.id, {
    onDelete: 'cascade',
  }),
  codeHash: text('code_hash').notNull(),
  proofHash: text('proof_hash'),
  expiresAt: text('expires_at').notNull(),
  verifiedAt: text('verified_at'),
  consumedAt: text('consumed_at'),
  invalidatedAt: text('invalidated_at'),
  createdAt: createdAt(),
});

export const passwordResetTokens = appSchema.table('password_reset_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: createdAt(),
});

export const installationSites = appSchema.table('installation_sites', {
  id: text('id').primaryKey(),
  pole: text('pole').notNull(),
  businessName: text('business_name').notNull(),
  roadAddress: text('road_address').notNull(),
  note: text('note'),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  coordinateSource: text('coordinate_source'),
  coordinateVerifiedAt: text('coordinate_verified_at'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const installationSiteDevices = appSchema.table(
  'installation_site_devices',
  {
    id: text('id').primaryKey(),
    installationSiteId: text('installation_site_id')
      .notNull()
      .references(() => installationSites.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    capacityLiters: integer('capacity_liters').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const settlements = appSchema.table('settlements', {
  id: text('id').primaryKey(),
  logisticsCompanyId: text('logistics_company_id')
    .notNull()
    .references(() => logisticsCompanies.id, { onDelete: 'restrict' }),
  settlementMonth: text('settlement_month').notNull(),
  transferStatus: text('transfer_status', {
    enum: ['pending', 'completed'],
  })
    .notNull()
    .default('pending'),
  transferredAt: text('transferred_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const mileageApplications = appSchema.table('mileage_applications', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  logisticsCompanyId: text('logistics_company_id')
    .notNull()
    .references(() => logisticsCompanies.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash'),
  photoMode: text('photo_mode', { enum: ['single', 'separate'] })
    .notNull()
    .default('separate'),
  receiptAmount: money('receipt_amount'),
  meterAmount: money('meter_amount'),
  finalAmount: money('final_amount'),
  liters: numeric('liters', { precision: 8, scale: 3 }),
  mileageAmount: money('mileage_amount'),
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
  reviewReplay: jsonb('review_replay').$type<{
    requestVersion: string;
    resultVersion: string;
  }>(),
  settlementId: text('settlement_id'),
  submittedAt: text('submitted_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  decidedAt: text('decided_at'),
  updatedAt: updatedAt(),
});

export const mileagePhotos = appSchema.table('mileage_application_photos', {
  id: text('id').primaryKey(),
  mileageApplicationId: text('mileage_application_id')
    .notNull()
    .references(() => mileageApplications.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['receipt', 'meter'] }).notNull(),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  originalStorageKey: text('original_storage_key'),
  originalContentType: text('original_content_type'),
  originalByteSize: integer('original_byte_size'),
  uploadedAt: text('uploaded_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: updatedAt(),
});

export const mileageUploadAttempts = appSchema.table(
  'mileage_upload_attempts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    storageKeys: jsonb('storage_keys').$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
);

export const mileageResubmissions = appSchema.table('mileage_resubmissions', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => mileageApplications.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  previousVersion: text('previous_version').notNull(),
  submissionVersion: text('submission_version').notNull(),
  previousRejectionReason: text('previous_rejection_reason'),
  previousDecidedAt: text('previous_decided_at'),
  createdAt: createdAt(),
});

export const mileageOcrJobs = appSchema.table('mileage_ocr_jobs', {
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
  lunaRetryReservedAt: text('luna_retry_reserved_at'),
  clovaDurationMs: integer('clova_duration_ms'),
  lunaDurationMs: integer('luna_duration_ms'),
  lunaInputTokens: integer('luna_input_tokens'),
  lunaOutputTokens: integer('luna_output_tokens'),
  result: jsonb('result_json').$type<Record<string, unknown> | null>(),
  errorCode: text('error_code'),
  createdAt: createdAt(),
  startedAt: text('started_at'),
  leaseExpiresAt: timestamp('lease_expires_at', {
    withTimezone: true,
    mode: 'date',
  }),
  finishedAt: text('finished_at'),
});

export const settlementSnapshots = appSchema.table('settlement_snapshots', {
  settlementId: text('settlement_id')
    .primaryKey()
    .references(() => settlements.id, { onDelete: 'restrict' }),
  reference: text('reference').notNull(),
  bankCode: text('bank_code').notNull(),
  accountNumber: text('account_number').notNull(),
  accountHolder: text('account_holder').notNull(),
  mileageAmount: money('mileage_amount').notNull(),
  capturedAt: text('captured_at').notNull(),
  capturedBy: text('captured_by')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
});

export const settlementCompletions = appSchema.table('settlement_completions', {
  settlementId: text('settlement_id')
    .primaryKey()
    .references(() => settlementSnapshots.settlementId, {
      onDelete: 'restrict',
    }),
  fileHash: text('file_hash').notNull(),
  completedBy: text('completed_by')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  completedAt: text('completed_at').notNull(),
});
