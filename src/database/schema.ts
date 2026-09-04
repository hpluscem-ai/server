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
