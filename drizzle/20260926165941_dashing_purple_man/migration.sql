DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN
    CREATE SCHEMA "app";
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "app"."admin_sessions" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_sessions" (
	"token_hash" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."installation_site_devices" (
	"id" text PRIMARY KEY,
	"installation_site_id" text NOT NULL,
	"model" text NOT NULL,
	"capacity_liters" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."installation_sites" (
	"id" text PRIMARY KEY,
	"pole" text NOT NULL,
	"business_name" text NOT NULL,
	"road_address" text NOT NULL,
	"note" text,
	"latitude" double precision,
	"longitude" double precision,
	"coordinate_source" text,
	"coordinate_verified_at" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."logistics_companies" (
	"id" text PRIMARY KEY,
	"business_name" text NOT NULL,
	"business_number" text NOT NULL,
	"corporate_registration_number" text NOT NULL,
	"business_address" text NOT NULL,
	"manager_name" text NOT NULL,
	"manager_phone" text NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_holder" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."mileage_applications" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"logistics_company_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text,
	"photo_mode" text DEFAULT 'separate' NOT NULL,
	"receipt_amount" bigint,
	"meter_amount" bigint,
	"final_amount" bigint,
	"mileage_amount" bigint,
	"receipt_at" text,
	"match_status" text DEFAULT 'pending' NOT NULL,
	"approval_status" text DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"settlement_id" text,
	"submitted_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"decided_at" text,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."mileage_ocr_jobs" (
	"id" text PRIMARY KEY,
	"application_id" text NOT NULL,
	"source_version" text NOT NULL,
	"extractor_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"clova_reserved_at" text,
	"luna_reserved_at" text,
	"luna_retry_reserved_at" text,
	"clova_duration_ms" integer,
	"luna_duration_ms" integer,
	"luna_input_tokens" integer,
	"luna_output_tokens" integer,
	"result_json" jsonb,
	"error_code" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"started_at" text,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "app"."mileage_application_photos" (
	"id" text PRIMARY KEY,
	"mileage_application_id" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"original_storage_key" text,
	"original_content_type" text,
	"original_byte_size" integer,
	"uploaded_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."mileage_resubmissions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."mileage_resubmissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"application_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"previous_version" text NOT NULL,
	"submission_version" text NOT NULL,
	"previous_rejection_reason" text,
	"previous_decided_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."mileage_upload_attempts" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"storage_keys" jsonb NOT NULL,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."password_reset_tokens" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."phone_verifications" (
	"id" text PRIMARY KEY,
	"purpose" text NOT NULL,
	"phone" text NOT NULL,
	"scope_email" text,
	"scope_user_id" text,
	"code_hash" text NOT NULL,
	"proof_hash" text,
	"expires_at" text NOT NULL,
	"verified_at" text,
	"consumed_at" text,
	"invalidated_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."settlement_completions" (
	"settlement_id" text PRIMARY KEY,
	"file_hash" text NOT NULL,
	"completed_by" text NOT NULL,
	"completed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."settlement_snapshots" (
	"settlement_id" text PRIMARY KEY,
	"reference" text NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_holder" text NOT NULL,
	"mileage_amount" bigint NOT NULL,
	"captured_at" text NOT NULL,
	"captured_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."settlements" (
	"id" text PRIMARY KEY,
	"logistics_company_id" text NOT NULL,
	"settlement_month" text NOT NULL,
	"transfer_status" text DEFAULT 'pending' NOT NULL,
	"transferred_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" text PRIMARY KEY,
	"role" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text NOT NULL,
	"phone" text,
	"logistics_company_id" text,
	"service_terms_consent" boolean DEFAULT false NOT NULL,
	"privacy_terms_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"deactivated_at" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."installation_site_devices" ADD CONSTRAINT "installation_site_devices_HwmE1uEEp3v1_fkey" FOREIGN KEY ("installation_site_id") REFERENCES "app"."installation_sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_ApMRRTahkHXi_fkey" FOREIGN KEY ("logistics_company_id") REFERENCES "app"."logistics_companies"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."mileage_ocr_jobs" ADD CONSTRAINT "mileage_ocr_jobs_application_id_mileage_applications_id_fkey" FOREIGN KEY ("application_id") REFERENCES "app"."mileage_applications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ADD CONSTRAINT "mileage_application_photos_tvvgXbAjAHYI_fkey" FOREIGN KEY ("mileage_application_id") REFERENCES "app"."mileage_applications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mileage_resubmissions" ADD CONSTRAINT "mileage_resubmissions_GhBrDB4aMeDF_fkey" FOREIGN KEY ("application_id") REFERENCES "app"."mileage_applications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."mileage_upload_attempts" ADD CONSTRAINT "mileage_upload_attempts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."phone_verifications" ADD CONSTRAINT "phone_verifications_scope_user_id_users_id_fkey" FOREIGN KEY ("scope_user_id") REFERENCES "app"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "app"."settlement_completions" ADD CONSTRAINT "settlement_completions_v78tU59eMgUh_fkey" FOREIGN KEY ("settlement_id") REFERENCES "app"."settlement_snapshots"("settlement_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."settlement_completions" ADD CONSTRAINT "settlement_completions_completed_by_users_id_fkey" FOREIGN KEY ("completed_by") REFERENCES "app"."users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_settlement_id_settlements_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "app"."settlements"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_captured_by_users_id_fkey" FOREIGN KEY ("captured_by") REFERENCES "app"."users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."settlements" ADD CONSTRAINT "settlements_logistics_company_id_logistics_companies_id_fkey" FOREIGN KEY ("logistics_company_id") REFERENCES "app"."logistics_companies"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_logistics_company_id_logistics_companies_id_fkey" FOREIGN KEY ("logistics_company_id") REFERENCES "app"."logistics_companies"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_role_check" CHECK (role IN ('admin', 'driver'));
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_driver_required_fields_check" CHECK (
  role = 'admin' OR (
    phone IS NOT NULL AND logistics_company_id IS NOT NULL AND
    service_terms_consent AND privacy_terms_consent
  )
);
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_password_or_withdrawn_driver_check" CHECK (
  password_hash IS NOT NULL OR (role = 'driver' AND deactivated_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_companies_business_number_key" ON "app"."logistics_companies" (lower(business_number));
--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_companies_corporate_registration_number_key" ON "app"."logistics_companies" (corporate_registration_number);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_registered_email_idx" ON "app"."users" (lower(email)) WHERE deactivated_at IS NULL OR role = 'admin';
--> statement-breakpoint
CREATE UNIQUE INDEX "users_registered_phone_idx" ON "app"."users" (phone) WHERE deactivated_at IS NULL OR role = 'admin';
--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "app"."users" (logistics_company_id, created_at) WHERE role = 'driver' AND deactivated_at IS NULL;
--> statement-breakpoint
ALTER TABLE "app"."installation_sites" ADD CONSTRAINT "installation_sites_coordinates_check" CHECK ((latitude IS NULL) = (longitude IS NULL));
--> statement-breakpoint
ALTER TABLE "app"."installation_sites" ADD CONSTRAINT "installation_sites_verified_coordinates_check" CHECK (coordinate_verified_at IS NULL OR latitude IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "app"."installation_sites" ADD CONSTRAINT "installation_sites_latitude_check" CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);
--> statement-breakpoint
ALTER TABLE "app"."installation_sites" ADD CONSTRAINT "installation_sites_longitude_check" CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
--> statement-breakpoint
ALTER TABLE "app"."installation_site_devices" ADD CONSTRAINT "installation_site_devices_capacity_check" CHECK (capacity_liters > 0);
--> statement-breakpoint
CREATE INDEX "installation_sites_bounds_idx" ON "app"."installation_sites" (active, latitude, longitude);
--> statement-breakpoint
CREATE INDEX "installation_site_devices_site_idx" ON "app"."installation_site_devices" (installation_site_id, active);
--> statement-breakpoint
ALTER TABLE "app"."settlements" ADD CONSTRAINT "settlements_company_month_key" UNIQUE (logistics_company_id, settlement_month);
--> statement-breakpoint
ALTER TABLE "app"."settlements" ADD CONSTRAINT "settlements_id_company_key" UNIQUE (id, logistics_company_id);
--> statement-breakpoint
ALTER TABLE "app"."settlements" ADD CONSTRAINT "settlements_month_check" CHECK (settlement_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
ALTER TABLE "app"."settlements" ADD CONSTRAINT "settlements_transfer_status_check" CHECK (transfer_status IN ('pending', 'completed'));
--> statement-breakpoint
ALTER TABLE "app"."settlements" ADD CONSTRAINT "settlements_transfer_time_check" CHECK (
  (transfer_status = 'pending' AND transferred_at IS NULL) OR
  (transfer_status = 'completed' AND transferred_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_settlement_company_fkey" FOREIGN KEY (settlement_id, logistics_company_id) REFERENCES "app"."settlements"(id, logistics_company_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_user_idempotency_key" UNIQUE (user_id, idempotency_key);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_receipt_amount_check" CHECK (receipt_amount IS NULL OR receipt_amount >= 0);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_meter_amount_check" CHECK (meter_amount IS NULL OR meter_amount >= 0);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_final_amount_check" CHECK (final_amount IS NULL OR final_amount >= 0);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_mileage_amount_check" CHECK (mileage_amount IS NULL OR mileage_amount BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_request_hash_check" CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_photo_mode_check" CHECK (photo_mode IN ('single', 'separate'));
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_match_status_check" CHECK (match_status IN ('pending', 'matched', 'mismatched', 'ocr_failed', 'duplicate_suspected'));
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_approval_status_check" CHECK (approval_status IN ('pending', 'approved', 'rejected'));
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_approved_fields_check" CHECK (
  approval_status <> 'approved' OR (final_amount IS NOT NULL AND mileage_amount IS NOT NULL AND decided_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_decided_check" CHECK (approval_status = 'pending' OR decided_at IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ADD CONSTRAINT "mileage_applications_settlement_approval_check" CHECK (settlement_id IS NULL OR approval_status = 'approved');
--> statement-breakpoint
CREATE INDEX "mileage_applications_user_date_idx" ON "app"."mileage_applications" (user_id, submitted_at DESC);
--> statement-breakpoint
CREATE INDEX "mileage_applications_review_idx" ON "app"."mileage_applications" (approval_status, submitted_at DESC);
--> statement-breakpoint
CREATE INDEX "mileage_applications_settlement_idx" ON "app"."mileage_applications" (settlement_id);
--> statement-breakpoint
CREATE INDEX "mileage_approved_decided_idx" ON "app"."mileage_applications" (decided_at) WHERE approval_status = 'approved';
--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ADD CONSTRAINT "mileage_application_photos_kind_check" CHECK (kind IN ('receipt', 'meter'));
--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ADD CONSTRAINT "mileage_application_photos_byte_size_check" CHECK (byte_size BETWEEN 1 AND 52428800);
--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ADD CONSTRAINT "mileage_application_photos_original_byte_size_check" CHECK (original_byte_size IS NULL OR original_byte_size BETWEEN 1 AND 52428800);
--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ADD CONSTRAINT "mileage_application_photos_application_kind_key" UNIQUE (mileage_application_id, kind);
--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ADD CONSTRAINT "mileage_application_photos_storage_key_key" UNIQUE (storage_key);
--> statement-breakpoint
CREATE UNIQUE INDEX "mileage_photos_original_key_idx" ON "app"."mileage_application_photos" (original_storage_key);
--> statement-breakpoint
ALTER TABLE "app"."mileage_upload_attempts" ADD CONSTRAINT "mileage_upload_attempts_storage_keys_check" CHECK (jsonb_typeof(storage_keys) = 'array' AND jsonb_array_length(storage_keys) IN (2, 4));
--> statement-breakpoint
ALTER TABLE "app"."mileage_resubmissions" ADD CONSTRAINT "mileage_resubmissions_application_idempotency_key" UNIQUE (application_id, idempotency_key);
--> statement-breakpoint
ALTER TABLE "app"."mileage_resubmissions" ADD CONSTRAINT "mileage_resubmissions_request_hash_check" CHECK (request_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."mileage_resubmissions" ADD CONSTRAINT "mileage_resubmissions_previous_version_check" CHECK (previous_version ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."mileage_resubmissions" ADD CONSTRAINT "mileage_resubmissions_submission_version_check" CHECK (submission_version ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."mileage_ocr_jobs" ADD CONSTRAINT "mileage_ocr_jobs_source_version_check" CHECK (source_version ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."mileage_ocr_jobs" ADD CONSTRAINT "mileage_ocr_jobs_status_check" CHECK (status IN ('queued', 'running', 'completed', 'failed', 'unknown'));
--> statement-breakpoint
ALTER TABLE "app"."mileage_ocr_jobs" ADD CONSTRAINT "mileage_ocr_jobs_application_source_extractor_key" UNIQUE (application_id, source_version, extractor_version);
--> statement-breakpoint
CREATE INDEX "mileage_ocr_jobs_status_idx" ON "app"."mileage_ocr_jobs" (status, created_at);
--> statement-breakpoint
CREATE INDEX "mileage_ocr_jobs_clova_reservation_idx" ON "app"."mileage_ocr_jobs" (clova_reserved_at);
--> statement-breakpoint
CREATE INDEX "mileage_ocr_jobs_luna_reservation_idx" ON "app"."mileage_ocr_jobs" (luna_reserved_at);
--> statement-breakpoint
CREATE INDEX "mileage_ocr_jobs_luna_retry_reservation_idx" ON "app"."mileage_ocr_jobs" (luna_retry_reserved_at);
--> statement-breakpoint
ALTER TABLE "app"."phone_verifications" ADD CONSTRAINT "phone_verifications_purpose_check" CHECK (purpose IN ('sign_up', 'find_email', 'reset_password', 'change_phone'));
--> statement-breakpoint
ALTER TABLE "app"."phone_verifications" ADD CONSTRAINT "phone_verifications_reset_scope_check" CHECK (purpose <> 'reset_password' OR scope_email IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "app"."phone_verifications" ADD CONSTRAINT "phone_verifications_proof_hash_key" UNIQUE (proof_hash);
--> statement-breakpoint
CREATE INDEX "phone_verifications_lookup_idx" ON "app"."phone_verifications" (purpose, phone, created_at DESC);
--> statement-breakpoint
ALTER TABLE "app"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE (token_hash);
--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_sessions_dates_check" CHECK (created_at <= last_used_at AND last_used_at < expires_at);
--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "app"."auth_sessions" (user_id);
--> statement-breakpoint
ALTER TABLE "app"."admin_sessions" ADD CONSTRAINT "admin_sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "app"."admin_sessions" ADD CONSTRAINT "admin_sessions_dates_check" CHECK (expires_at > created_at);
--> statement-breakpoint
CREATE INDEX "admin_sessions_user_idx" ON "app"."admin_sessions" (user_id);
--> statement-breakpoint
ALTER TABLE "app"."settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_reference_key" UNIQUE (reference);
--> statement-breakpoint
ALTER TABLE "app"."settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_reference_check" CHECK (reference ~ '^[0-9]{10}$');
--> statement-breakpoint
ALTER TABLE "app"."settlement_snapshots" ADD CONSTRAINT "settlement_snapshots_mileage_amount_check" CHECK (mileage_amount BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE "app"."settlement_completions" ADD CONSTRAINT "settlement_completions_file_hash_check" CHECK (file_hash ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE FUNCTION "app"."guard_mileage_application"() RETURNS trigger LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'driver' AND logistics_company_id = NEW.logistics_company_id
  ) THEN RAISE EXCEPTION 'mileage application requires the driver current company'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.logistics_company_id <> OLD.logistics_company_id) THEN
    RAISE EXCEPTION 'mileage application ownership cannot be changed';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.approval_status = 'approved' AND OLD.photo_mode IS DISTINCT FROM NEW.photo_mode THEN
    RAISE EXCEPTION 'approved mileage application photos cannot be changed';
  END IF;
  IF NEW.approval_status = 'approved' AND (
    NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'receipt') OR
    (NEW.photo_mode = 'separate' AND NOT EXISTS (SELECT 1 FROM mileage_application_photos WHERE mileage_application_id = NEW.id AND kind = 'meter'))
  ) THEN RAISE EXCEPTION 'approved mileage application requires selected photos'; END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id IN (OLD.settlement_id, NEW.settlement_id)) THEN
    RAISE EXCEPTION 'captured settlement applications cannot be changed';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (OLD.settlement_id IS NOT NULL AND EXISTS (SELECT 1 FROM settlements WHERE id = OLD.settlement_id AND transfer_status = 'completed')) OR
    (NEW.settlement_id IS NOT NULL AND NEW.settlement_id IS DISTINCT FROM OLD.settlement_id AND EXISTS (SELECT 1 FROM settlements WHERE id = NEW.settlement_id AND transfer_status = 'completed'))
  ) THEN RAISE EXCEPTION 'completed settlement applications cannot be changed'; END IF;
  IF TG_OP = 'INSERT' AND NEW.settlement_id IS NOT NULL AND EXISTS (SELECT 1 FROM settlements WHERE id = NEW.settlement_id AND transfer_status = 'completed') THEN
    RAISE EXCEPTION 'completed settlement cannot accept applications';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = NEW.settlement_id) THEN
    RAISE EXCEPTION 'captured settlement cannot accept applications';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mileage_applications_guard" BEFORE INSERT OR UPDATE ON "app"."mileage_applications" FOR EACH ROW EXECUTE FUNCTION "app"."guard_mileage_application"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_mileage_application_delete"() RETURNS trigger LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF OLD.settlement_id IS NOT NULL AND EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = OLD.settlement_id) THEN
    RAISE EXCEPTION 'captured settlement applications cannot be removed';
  END IF;
  IF OLD.settlement_id IS NOT NULL AND EXISTS (SELECT 1 FROM settlements WHERE id = OLD.settlement_id AND transfer_status = 'completed') THEN
    RAISE EXCEPTION 'completed settlement applications cannot be removed';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mileage_applications_delete_guard" BEFORE DELETE ON "app"."mileage_applications" FOR EACH ROW EXECUTE FUNCTION "app"."guard_mileage_application_delete"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_mileage_photo"() RETURNS trigger LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mileage_applications WHERE id = OLD.mileage_application_id AND approval_status = 'approved') THEN
    RAISE EXCEPTION 'approved mileage application photos cannot be changed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mileage_application_photos_guard" BEFORE UPDATE OR DELETE ON "app"."mileage_application_photos" FOR EACH ROW EXECUTE FUNCTION "app"."guard_mileage_photo"();
--> statement-breakpoint
CREATE FUNCTION "app"."guard_settlement"() RETURNS trigger LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.transfer_status = 'completed' THEN RAISE EXCEPTION 'settlement must be created before it is completed'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.transfer_status = 'completed' THEN RAISE EXCEPTION 'completed settlement cannot be changed'; END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM settlement_snapshots WHERE settlement_id = OLD.id) THEN
    IF NEW.id <> OLD.id OR NEW.logistics_company_id <> OLD.logistics_company_id OR NEW.settlement_month <> OLD.settlement_month THEN
      RAISE EXCEPTION 'captured settlement identity cannot be changed';
    END IF;
    IF NEW.transfer_status = 'completed' AND NOT EXISTS (
      SELECT 1 FROM settlement_completions WHERE settlement_id = OLD.id AND completed_at = NEW.transferred_at
    ) THEN RAISE EXCEPTION 'settlement requires an upload completion record'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.transfer_status = 'pending' AND NEW.transfer_status = 'completed' AND NOT EXISTS (
    SELECT 1 FROM mileage_applications WHERE settlement_id = NEW.id AND approval_status = 'approved'
  ) THEN RAISE EXCEPTION 'settlement requires an approved mileage application'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "settlements_guard" BEFORE INSERT OR UPDATE ON "app"."settlements" FOR EACH ROW EXECUTE FUNCTION "app"."guard_settlement"();
--> statement-breakpoint
CREATE FUNCTION "app"."immutable_record"() RETURNS trigger LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN RAISE EXCEPTION '% cannot be changed', TG_TABLE_NAME; END;
$$;
--> statement-breakpoint
CREATE TRIGGER "settlement_snapshots_immutable" BEFORE UPDATE OR DELETE ON "app"."settlement_snapshots" FOR EACH ROW EXECUTE FUNCTION "app"."immutable_record"();
--> statement-breakpoint
CREATE TRIGGER "settlement_completions_immutable" BEFORE UPDATE OR DELETE ON "app"."settlement_completions" FOR EACH ROW EXECUTE FUNCTION "app"."immutable_record"();
--> statement-breakpoint
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE "app"."admin_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."installation_site_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."installation_sites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."logistics_companies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."mileage_applications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."mileage_application_photos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."mileage_ocr_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."mileage_resubmissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."mileage_upload_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."password_reset_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."phone_verifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."settlements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."settlement_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."settlement_completions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."users" ENABLE ROW LEVEL SECURITY;
