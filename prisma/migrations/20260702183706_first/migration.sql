-- CreateEnum
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'TRIALING');

-- CreateEnum
CREATE TYPE "public"."LeaseStatus" AS ENUM ('ACTIVE', 'ENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "public"."RentChargeStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'VOIDED');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('CONFIRMED', 'VOIDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."ExpenseCategory" AS ENUM ('MAINTENANCE', 'UTILITIES', 'INSURANCE', 'PROPERTY_TAX', 'MANAGEMENT_FEE', 'CLEANING', 'LANDSCAPING', 'LEGAL', 'MARKETING', 'SUPPLIES', 'RENOVATION', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."OtherIncomeType" AS ENUM ('PARKING', 'LAUNDRY', 'LATE_FEE', 'PET_FEE', 'STORAGE', 'SECURITY_DEPOSIT_FORFEITURE', 'UTILITY_REIMBURSEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'VOID', 'REFUND', 'MOVE_IN', 'MOVE_OUT', 'GENERATE', 'RECALCULATE');

-- CreateEnum
CREATE TYPE "public"."PeriodType" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "public"."RateLimitToken" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "public"."Plan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_is_active_deleted_at_idx" ON "public"."User"("is_active", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_user_id_key" ON "public"."Subscription"("user_id");

-- CreateIndex
CREATE INDEX "Subscription_status_current_period_end_idx" ON "public"."Subscription"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "House_owner_id_deleted_at_idx" ON "public"."House"("owner_id", "deleted_at");

-- CreateIndex
CREATE INDEX "House_owner_id_idx" ON "public"."House"("owner_id");

-- CreateIndex
CREATE INDEX "Unit_house_id_deleted_at_idx" ON "public"."Unit"("house_id", "deleted_at");

-- CreateIndex
CREATE INDEX "Unit_house_id_idx" ON "public"."Unit"("house_id");

-- CreateIndex
CREATE INDEX "Tenant_owner_id_deleted_at_idx" ON "public"."Tenant"("owner_id", "deleted_at");

-- CreateIndex
CREATE INDEX "Tenant_owner_id_full_name_idx" ON "public"."Tenant"("owner_id", "full_name");

-- CreateIndex
CREATE INDEX "Tenant_email_idx" ON "public"."Tenant"("email");

-- CreateIndex
CREATE INDEX "Lease_unit_id_status_idx" ON "public"."Lease"("unit_id", "status");

-- CreateIndex
CREATE INDEX "Lease_house_id_status_idx" ON "public"."Lease"("house_id", "status");

-- CreateIndex
CREATE INDEX "Lease_tenant_id_idx" ON "public"."Lease"("tenant_id");

-- CreateIndex
CREATE INDEX "Lease_status_end_date_idx" ON "public"."Lease"("status", "end_date");

-- CreateIndex
CREATE INDEX "Lease_house_id_tenant_id_idx" ON "public"."Lease"("house_id", "tenant_id");

-- CreateIndex
CREATE INDEX "RentRate_unit_id_effective_to_idx" ON "public"."RentRate"("unit_id", "effective_to");

-- CreateIndex
CREATE INDEX "RentRate_unit_id_effective_from_idx" ON "public"."RentRate"("unit_id", "effective_from");

-- CreateIndex
CREATE INDEX "RentCharge_house_id_due_month_idx" ON "public"."RentCharge"("house_id", "due_month");

-- CreateIndex
CREATE INDEX "RentCharge_lease_id_idx" ON "public"."RentCharge"("lease_id");

-- CreateIndex
CREATE INDEX "RentCharge_tenant_id_due_month_idx" ON "public"."RentCharge"("tenant_id", "due_month");

-- CreateIndex
CREATE INDEX "RentCharge_status_due_date_idx" ON "public"."RentCharge"("status", "due_date");

-- CreateIndex
CREATE INDEX "RentCharge_house_id_status_idx" ON "public"."RentCharge"("house_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RentCharge_unit_id_lease_id_due_month_key" ON "public"."RentCharge"("unit_id", "lease_id", "due_month");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotency_key_key" ON "public"."Payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "Payment_rent_charge_id_status_idx" ON "public"."Payment"("rent_charge_id", "status");

-- CreateIndex
CREATE INDEX "Payment_date_paid_idx" ON "public"."Payment"("date_paid");

-- CreateIndex
CREATE INDEX "Payment_status_date_paid_idx" ON "public"."Payment"("status", "date_paid");

-- CreateIndex
CREATE INDEX "Payment_recorded_by_idx" ON "public"."Payment"("recorded_by");

-- CreateIndex
CREATE INDEX "Expense_house_id_expense_date_deleted_at_idx" ON "public"."Expense"("house_id", "expense_date", "deleted_at");

-- CreateIndex
CREATE INDEX "Expense_house_id_category_idx" ON "public"."Expense"("house_id", "category");

-- CreateIndex
CREATE INDEX "Expense_unit_id_expense_date_idx" ON "public"."Expense"("unit_id", "expense_date");

-- CreateIndex
CREATE INDEX "OtherIncome_house_id_income_date_deleted_at_idx" ON "public"."OtherIncome"("house_id", "income_date", "deleted_at");

-- CreateIndex
CREATE INDEX "OtherIncome_house_id_type_idx" ON "public"."OtherIncome"("house_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_file_key_key" ON "public"."Attachment"("file_key");

-- CreateIndex
CREATE INDEX "Attachment_owner_type_owner_id_idx" ON "public"."Attachment"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "Attachment_deleted_at_idx" ON "public"."Attachment"("deleted_at");

-- CreateIndex
CREATE INDEX "AuditLog_entity_type_entity_id_idx" ON "public"."AuditLog"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "AuditLog_actor_id_created_at_idx" ON "public"."AuditLog"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "AuditLog_created_at_idx" ON "public"."AuditLog"("created_at");

-- CreateIndex
CREATE INDEX "AuditLog_action_entity_type_idx" ON "public"."AuditLog"("action", "entity_type");

-- CreateIndex
CREATE INDEX "ReportSnapshot_house_id_period_key_idx" ON "public"."ReportSnapshot"("house_id", "period_key");

-- CreateIndex
CREATE INDEX "ReportSnapshot_is_final_period_key_idx" ON "public"."ReportSnapshot"("is_final", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSnapshot_house_id_period_type_period_key_key" ON "public"."ReportSnapshot"("house_id", "period_type", "period_key");

-- CreateIndex
CREATE INDEX "RateLimitToken_key_created_at_idx" ON "public"."RateLimitToken"("key", "created_at");

-- AddForeignKey
ALTER TABLE "public"."Subscription" ADD CONSTRAINT "Subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Subscription" ADD CONSTRAINT "Subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."House" ADD CONSTRAINT "House_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Unit" ADD CONSTRAINT "Unit_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Lease" ADD CONSTRAINT "Lease_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Lease" ADD CONSTRAINT "Lease_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Lease" ADD CONSTRAINT "Lease_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RentRate" ADD CONSTRAINT "RentRate_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RentCharge" ADD CONSTRAINT "RentCharge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_rent_charge_id_fkey" FOREIGN KEY ("rent_charge_id") REFERENCES "public"."RentCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Expense" ADD CONSTRAINT "Expense_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OtherIncome" ADD CONSTRAINT "OtherIncome_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OtherIncome" ADD CONSTRAINT "OtherIncome_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "public"."Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."Lease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Attachment" ADD CONSTRAINT "Attachment_other_income_id_fkey" FOREIGN KEY ("other_income_id") REFERENCES "public"."OtherIncome"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."House"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
