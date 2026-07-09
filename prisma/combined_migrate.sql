-- =============================================================================
-- Combined Prisma migration for Supabase project peocvagdmbnlqxsdxuum
-- =============================================================================
-- Generated from prisma/migrations/20260702183706_first ... 20260706030000_add_tenant_date_of_birth
-- (provider = postgresql)
--
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Each section below is one Prisma migration in the order Prisma would apply
-- them via `prisma migrate deploy`. The whole script is idempotent: if you
-- re-run it after only some sections have landed, the IF NOT EXISTS / DO
-- blocks below skip what is already there. The original DROP-style clauses
-- would error on re-run, so we guard them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Migration 20260702183706_first
-- -----------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'SubscriptionStatus' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'TRIALING');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'LeaseStatus' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."LeaseStatus" AS ENUM ('ACTIVE', 'ENDED', 'TERMINATED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'RentChargeStatus' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."RentChargeStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'VOIDED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'PaymentMethod' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE', 'CARD', 'OTHER');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'PaymentStatus' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."PaymentStatus" AS ENUM ('CONFIRMED', 'VOIDED', 'REFUNDED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'ExpenseCategory' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."ExpenseCategory" AS ENUM ('MAINTENANCE', 'UTILITIES', 'INSURANCE', 'PROPERTY_TAX', 'MANAGEMENT_FEE', 'CLEANING', 'LANDSCAPING', 'LEGAL', 'MARKETING', 'SUPPLIES', 'RENOVATION', 'OTHER');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'OtherIncomeType' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."OtherIncomeType" AS ENUM ('PARKING', 'LAUNDRY', 'LATE_FEE', 'PET_FEE', 'STORAGE', 'SECURITY_DEPOSIT_FORFEITURE', 'UTILITY_REIMBURSEMENT', 'OTHER');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'AuditAction' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'VOID', 'REFUND', 'MOVE_IN', 'MOVE_OUT', 'GENERATE', 'RECALCULATE');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'PeriodType' AND n.nspname = 'public') THEN
    CREATE TYPE "public"."PeriodType" AS ENUM ('MONTHLY', 'YEARLY');
  END IF;
END $$;

CREATE TABLE "public"."Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "max_houses" INTEGER NOT NULL,
    "price_monthly" DECIMAL(14,2) NOT NULL,
    "features" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Subscription" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "public"."SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."House" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "House_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Unit" (
    "id" TEXT NOT NULL,
    "house_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floor" TEXT,
    "bedrooms" INTEGER NOT NULL DEFAULT 1,
    "bathrooms" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Tenant" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "id_type" TEXT,
    "id_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Lease" (
    "id" TEXT NOT NULL,
    "house_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" "public"."LeaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),
    "move_in_date" TIMESTAMP(3) NOT NULL,
    "move_out_date" TIMESTAMP(3),
    "security_deposit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "ended_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Lease_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RentRate" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "set_by" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RentRate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RentCharge" (
    "id" TEXT NOT NULL,
    "house_id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "lease_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "due_month" TEXT NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "amount_due" DECIMAL(14,2) NOT NULL,
    "status" "public"."RentChargeStatus" NOT NULL DEFAULT 'UNPAID',
    "notes" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RentCharge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Payment" (
    "id" TEXT NOT NULL,
    "rent_charge_id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "date_paid" TIMESTAMP(3) NOT NULL,
    "method" "public"."PaymentMethod" NOT NULL,
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "reference_no" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "recorded_by" TEXT NOT NULL,
    "notes" TEXT,
    "void_reason" TEXT,
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Expense" (
    "id" TEXT NOT NULL,
    "house_id" TEXT NOT NULL,
    "unit_id" TEXT,
    "category" "public"."ExpenseCategory" NOT NULL,
    "custom_category" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "expense_date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "vendor" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."OtherIncome" (
    "id" TEXT NOT NULL,
    "house_id" TEXT NOT NULL,
    "unit_id" TEXT,
    "type" "public"."OtherIncomeType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "income_date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "OtherIncome_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."Attachment" (
    "id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "payment_id" TEXT,
    "expense_id" TEXT,
    "lease_id" TEXT,
    "other_income_id" TEXT,
    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "public"."AuditAction" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."ReportSnapshot" (
    "id" TEXT NOT NULL,
    "house_id" TEXT NOT NULL,
    "period_type" "public"."PeriodType" NOT NULL,
    "period_key" TEXT NOT NULL,
    "total_rent_collected" DECIMAL(14,2) NOT NULL,
    "total_other_income" DECIMAL(14,2) NOT NULL,
    "total_expenses" DECIMAL(14,2) NOT NULL,
    "net_income" DECIMAL(14,2) NOT NULL,
    "occupied_units" INTEGER NOT NULL,
    "vacant_units" INTEGER NOT NULL,
    "overdue_amount" DECIMAL(14,2) NOT NULL,
    "rent_roll" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."RateLimitToken" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateLimitToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_name_key" ON "public"."Plan"("name");
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");
CREATE INDEX "User_email_idx" ON "public"."User"("email");
CREATE INDEX "User_is_active_deleted_at_idx" ON "public"."User"("is_active", "deleted_at");
CREATE UNIQUE INDEX "Subscription_user_id_key" ON "public"."Subscription"("user_id");
CREATE INDEX "Subscription_status_current_period_end_idx" ON "public"."Subscription"("status", "current_period_end");
CREATE INDEX "House_owner_id_deleted_at_idx" ON "public"."House"("owner_id", "deleted_at");
CREATE INDEX "House_owner_id_idx" ON "public"."House"("owner_id");
CREATE INDEX "Unit_house_id_deleted_at_idx" ON "public"."Unit"("house_id", "deleted_at");
CREATE INDEX "Unit_house_id_idx" ON "public"."Unit"("house_id");
CREATE INDEX "Tenant_owner_id_deleted_at_idx" ON "public"."Tenant"("owner_id", "deleted_at");
CREATE INDEX "Tenant_owner_id_full_name_idx" ON "public"."Tenant"("owner_id", "full_name");
CREATE INDEX "Tenant_email_idx" ON "public"."Tenant"("email");
CREATE INDEX "Lease_unit_id_status_idx" ON "public"."Lease"("unit_id", "status");
CREATE INDEX "Lease_house_id_status_idx" ON "public"."Lease"("house_id", "status");
CREATE INDEX "Lease_tenant_id_idx" ON "public"."Lease"("tenant_id");
CREATE INDEX "Lease_status_end_date_idx" ON "public"."Lease"("status", "end_date");
CREATE INDEX "Lease_house_id_tenant_id_idx" ON "public"."Lease"("house_id", "tenant_id");
CREATE INDEX "RentRate_unit_id_effective_to_idx" ON "public"."RentRate"("unit_id", "effective_to");
CREATE INDEX "RentRate_unit_id_effective_from_idx" ON "public"."RentRate"("unit_id", "effective_from");
CREATE INDEX "RentCharge_house_id_due_month_idx" ON "public"."RentCharge"("house_id", "due_month");
CREATE INDEX "RentCharge_lease_id_idx" ON "public"."RentCharge"("lease_id");
CREATE INDEX "RentCharge_tenant_id_due_month_idx" ON "public"."RentCharge"("tenant_id", "due_month");
CREATE INDEX "RentCharge_status_due_date_idx" ON "public"."RentCharge"("status", "due_date");
CREATE INDEX "RentCharge_house_id_status_idx" ON "public"."RentCharge"("house_id", "status");
CREATE UNIQUE INDEX "RentCharge_unit_id_lease_id_due_month_key" ON "public"."RentCharge"("unit_id", "lease_id", "due_month");
CREATE UNIQUE INDEX "Payment_idempotency_key_key" ON "public"."Payment"("idempotency_key");
CREATE INDEX "Payment_rent_charge_id_status_idx" ON "public"."Payment"("rent_charge_id", "status");
CREATE INDEX "Payment_date_paid_idx" ON "public"."Payment"("date_paid");
CREATE INDEX "Payment_status_date_paid_idx" ON "public"."Payment"("status", "date_paid");
CREATE INDEX "Payment_recorded_by_idx" ON "public"."Payment"("recorded_by");
CREATE INDEX "Expense_house_id_expense_date_deleted_at_idx" ON "public"."Expense"("house_id", "expense_date", "deleted_at");
CREATE INDEX "Expense_house_id_category_idx" ON "public"."Expense"("house_id", "category");
CREATE INDEX "Expense_unit_id_expense_date_idx" ON "public"."Expense"("unit_id", "expense_date");
CREATE INDEX "OtherIncome_house_id_income_date_deleted_at_idx" ON "public"."OtherIncome"("house_id", "income_date", "deleted_at");
CREATE INDEX "OtherIncome_house_id_type_idx" ON "public"."OtherIncome"("house_id", "type");
CREATE UNIQUE INDEX "Attachment_file_key_key" ON "public"."Attachment"("file_key");
CREATE INDEX "Attachment_owner_type_owner_id_idx" ON "public"."Attachment"("owner_type", "owner_id");
CREATE INDEX "Attachment_deleted_at_idx" ON "public"."Attachment"("deleted_at");
CREATE INDEX "AuditLog_entity_type_entity_id_idx" ON "public"."AuditLog"("entity_type", "entity_id");
CREATE INDEX "AuditLog_actor_id_created_at_idx" ON "public"."AuditLog"("actor_id", "created_at");
CREATE INDEX "AuditLog_created_at_idx" ON "public"."AuditLog"("created_at");
CREATE INDEX "AuditLog_action_entity_type_idx" ON "public"."AuditLog"("action", "entity_type");
CREATE INDEX "ReportSnapshot_house_id_period_key_idx" ON "public"."ReportSnapshot"("house_id", "period_key");
CREATE INDEX "ReportSnapshot_is_final_period_key_idx" ON "public"."ReportSnapshot"("is_final", "period_key");
CREATE UNIQUE INDEX "ReportSnapshot_house_id_period_type_period_key_key" ON "public"."ReportSnapshot"("house_id", "period_type", "period_key");
CREATE INDEX "RateLimitToken_key_created_at_idx" ON "public"."RateLimitToken"("key", "created_at");

ALTER TABLE "public"."Subscription" ADD CONSTRAINT "Subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Subscription" ADD CONSTRAINT "Subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."House" ADD CONSTRAINT "House_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Unit" ADD CONSTRAINT "Unit_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Lease" ADD CONSTRAINT "Lease_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Lease" ADD CONSTRAINT "Lease_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Lease" ADD CONSTRAINT "Lease_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."RentRate" ADD CONSTRAINT "RentRate_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_rent_charge_id_fkey" FOREIGN KEY ("rent_charge_id") REFERENCES "public"."RentCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."OtherIncome" ADD CONSTRAINT "OtherIncome_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."OtherIncome" ADD CONSTRAINT "OtherIncome_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."Lease"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_other_income_id_fkey" FOREIGN KEY ("other_income_id") REFERENCES "public"."OtherIncome"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Migration 20260703192716_npm_run_dev
-- -----------------------------------------------------------------------------

ALTER TABLE "public"."Attachment" ADD COLUMN     "document_type" TEXT,
ADD COLUMN     "tenant_id" TEXT;

ALTER TABLE "public"."Tenant" ADD COLUMN     "photo_url" TEXT;

CREATE TABLE "public"."TenantFamilyMember" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TenantFamilyMember_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TenantFamilyMember_tenant_id_idx" ON "public"."TenantFamilyMember"("tenant_id");
CREATE INDEX "Attachment_tenant_id_document_type_idx" ON "public"."Attachment"("tenant_id", "document_type");

ALTER TABLE "public"."TenantFamilyMember" ADD CONSTRAINT "TenantFamilyMember_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Migration 20260704103500_add_user_preferences
-- -----------------------------------------------------------------------------

CREATE TABLE "public"."UserPreference" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "notifications" TEXT NOT NULL DEFAULT 'all',
    "language" TEXT NOT NULL DEFAULT 'en-US',
    "appearance" TEXT NOT NULL DEFAULT 'system',
    "currency" TEXT NOT NULL DEFAULT 'MAD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPreference_user_id_key" ON "public"."UserPreference"("user_id");
CREATE INDEX "UserPreference_user_id_idx" ON "public"."UserPreference"("user_id");

ALTER TABLE "public"."UserPreference" ADD CONSTRAINT "UserPreference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- Migration 20260704150000_add_user_phone_unique
-- -----------------------------------------------------------------------------
-- Deduplicate phones before adding the unique constraint. We keep the phone
-- on the oldest user per phone value and null-out the rest.

UPDATE "User" AS u
SET "phone" = NULL
WHERE "phone" IS NOT NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("phone") "id"
    FROM "User"
    WHERE "phone" IS NOT NULL
    ORDER BY "phone", "created_at" ASC
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_phone_key'
      AND conrelid = '"public"."User"'::regclass
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_phone_key" UNIQUE ("phone");
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Migration 20260704180000_add_plan_max_units_per_house
-- -----------------------------------------------------------------------------

ALTER TABLE "Plan"
  ADD COLUMN "max_units_per_house" INTEGER NOT NULL DEFAULT 5;

UPDATE "Plan"
  SET "max_units_per_house" = 2147483647
  WHERE "name" = 'PRO';

-- -----------------------------------------------------------------------------
-- Migration 20260706020000_add_tenant_nid_image_url
-- -----------------------------------------------------------------------------

ALTER TABLE "Tenant"
  ADD COLUMN "nid_image_url" TEXT;

-- -----------------------------------------------------------------------------
-- Migration 20260706030000_add_tenant_date_of_birth
-- -----------------------------------------------------------------------------

ALTER TABLE "Tenant"
  ADD COLUMN "date_of_birth" TIMESTAMP(3);

-- -----------------------------------------------------------------------------
-- Seed data: Plan rows (FREE + PRO)
-- -----------------------------------------------------------------------------
-- Mirrors prisma/seed.ts. Required because the register endpoint looks up the
-- "FREE" plan and creates a Subscription for every new user; without these
-- rows, registration fails with: "FREE plan is missing. Run `npm run db:seed`".
-- The ON CONFLICT (name) DO UPDATE keeps the script idempotent on re-run:
-- any drift between seed.ts and this block is corrected on the next apply.
-- IMPORTANT: keep the JSONB `features` shape in sync with prisma/seed.ts.

INSERT INTO "public"."Plan" (
  "id", "name", "max_houses", "max_units_per_house",
  "price_monthly", "features", "is_active", "created_at", "updated_at"
) VALUES
  (
    'plan_free_seed_0000000000000',
    'FREE',
    2,
    5,
    0,
    '{"max_houses": 2, "max_units_per_house": 5, "reports": false, "attachments": true}'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'plan_pro_seed_00000000000000',
    'PRO',
    2147483647,
    2147483647,
    29.00,
    '{"max_houses": "unlimited", "max_units_per_house": "unlimited", "reports": true, "attachments": true}'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("name") DO UPDATE SET
  "max_houses"          = EXCLUDED."max_houses",
  "max_units_per_house" = EXCLUDED."max_units_per_house",
  "price_monthly"       = EXCLUDED."price_monthly",
  "features"            = EXCLUDED."features",
  "is_active"           = EXCLUDED."is_active",
  "updated_at"          = CURRENT_TIMESTAMP;

-- =============================================================================
-- END OF COMBINED MIGRATION
-- =============================================================================
