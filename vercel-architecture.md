# Tenant Management SaaS — Final Architecture (Vercel)

> All fixes applied:
> - Tenant scoped to owner, house isolation through leases only
> - No Redis, no BullMQ — replaced with DB-native patterns
> - Only 2 Vercel Cron jobs (free tier limit)
> - Reports computed lazily, cached in report_snapshots
> - Rate limiting via DB, not Redis
> - No contradictions between stack and what Vercel can actually run
> - **v2 additions (against product screenshots):** tenant profile photo, tenant ID documents (image or PDF) via Attachments, tenant family members, and three orchestration endpoints (create-unit-with-rent, tenant onboarding, simplified payment recording) so the simplified UI forms don't need to know about the underlying multi-table model

---

## 1. What This System Does

A landlord (owner) signs up and manages their property portfolio:

```
Owner
 └── House (an apartment building)
      ├── Unit A  ── [active lease] ── Tenant Alice   ← occupied
      ├── Unit B  ── [active lease] ── Tenant Bob     ← occupied
      └── Unit C  ── [no lease]                       ← vacant
```

- A **tenant** is a person profile owned by the landlord. They exist independently of any unit — their connection to a house and unit lives entirely in the `lease` table.
- A **lease** is the record that binds a tenant to a unit, inside a house, for a period of time.
- **Current occupant** of a unit = the lease with `status = ACTIVE` for that unit.
- **Tenant history** = all leases ever created for that tenant, across any unit.
- **Financial truth** is append-only. No payment, charge, or rent rate is ever overwritten.

---

## 2. Stack — Honest Vercel Edition

| Layer | Choice | Why |
|---|---|---|
| **Framework** | Next.js 14 App Router | Full-stack on Vercel, API routes are serverless functions |
| **Database** | Supabase PostgreSQL | Free 500MB, managed, supports all Prisma features |
| **ORM** | Prisma (no Accelerate) | Standard Prisma, pooler handles connections |
| **Connection pool** | Supabase Transaction Pooler port 6543 | Prevents connection exhaustion on serverless |
| **Auth** | NextAuth.js v5 | Serverless-compatible, JWT strategy |
| **Validation** | Zod | Works everywhere, no decorators needed |
| **Background jobs** | Vercel Cron (2 jobs on Hobby) | Rent charge generation + overdue detection |
| **Email reminders** | Resend | 3,000 emails/month free, simple API |
| **File storage** | Cloudflare R2 | 10GB free, S3-compatible, zero egress fees |
| **Rate limiting** | DB-based token bucket | No Redis needed at MVP scale |
| **Caching** | report_snapshots table | Reports cached in DB, recomputed on demand |
| **Type safety** | TypeScript end-to-end | Shared types between API and UI |

### What is intentionally removed vs the original design

| Original | Removed | Replaced With |
|---|---|---|
| NestJS | ✗ | Next.js API Route Handlers |
| BullMQ | ✗ | Vercel Cron (2 jobs) |
| Redis | ✗ | DB-native rate limiting |
| QStash | ✗ | Not needed |
| Upstash | ✗ | Not needed at this scale |
| 4+ cron jobs | ✗ | 2 essential crons only |

---

## 3. Domain Model

```
users
 └── subscriptions → plans

users
 └── houses
      └── units
           ├── leases → tenants        (who lives here, history of who lived here)
           ├── rent_rates              (what rent is owed, history of rate changes)
           └── rent_charges → payments (what was charged, what was paid)

houses
 ├── expenses                          (house-level and unit-level spending)
 ├── other_income                      (non-rent income)
 └── report_snapshots                  (cached monthly/yearly reports)

[payments | expenses | leases | other_income]
 └── attachments                       (receipts, bills, documents)

[any entity]
 └── audit_logs                        (append-only mutation history)
```

### Tenant Scoping — Final Decision

**Tenants are scoped to the owner, not the house.**

A tenant profile (`full_name`, `email`, `phone`) belongs to the landlord. House and unit assignment lives in the `lease` table. This means:

- Owner opens House 1 → queries `leases WHERE house_id = X AND status = ACTIVE` → gets current tenants
- Owner searches "Alice" → finds her tenant record → sees her full lease history across all units
- If Alice moves from Unit A to Unit B in the same building: end old lease, create new lease. Tenant profile unchanged.
- No duplication of contact details if a tenant moves between units

House isolation is real and enforced — it just lives in the lease, not on the tenant row.

---

## 4. Prisma Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")         // Supabase Transaction Pooler — port 6543
  directUrl = env("DIRECT_DATABASE_URL")  // Direct connection — port 5432, migrations only
}

// ─── PLANS ────────────────────────────────────────────────────────────────────

model Plan {
  id            String   @id @default(uuid())
  name          String   @unique           // "FREE" | "STARTER" | "PRO"
  max_houses    Int                        // 2 for FREE
  price_monthly Decimal  @db.Decimal(14,2)
  features      Json
  is_active     Boolean  @default(true)
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  subscriptions Subscription[]
}

// ─── USERS ────────────────────────────────────────────────────────────────────

model User {
  id            String    @id @default(uuid())
  email         String    @unique
  password_hash String
  full_name     String
  phone         String?
  is_verified   Boolean   @default(false)
  is_active     Boolean   @default(true)
  created_at    DateTime  @default(now())
  updated_at    DateTime  @updatedAt
  deleted_at    DateTime?

  subscription Subscription?
  houses       House[]
  audit_logs   AuditLog[]    @relation("AuditActor")

  @@index([email])
  @@index([is_active, deleted_at])
}

// ─── SUBSCRIPTIONS ────────────────────────────────────────────────────────────

model Subscription {
  id                   String             @id @default(uuid())
  user_id              String             @unique
  plan_id              String
  status               SubscriptionStatus @default(ACTIVE)
  current_period_start DateTime
  current_period_end   DateTime
  cancelled_at         DateTime?
  created_at           DateTime           @default(now())
  updated_at           DateTime           @updatedAt

  user User @relation(fields: [user_id], references: [id])
  plan Plan @relation(fields: [plan_id], references: [id])

  @@index([status, current_period_end])   // cron: find expiring subscriptions
}

enum SubscriptionStatus {
  ACTIVE
  PAST_DUE
  CANCELLED
  TRIALING
}

// ─── HOUSES ───────────────────────────────────────────────────────────────────

model House {
  id          String    @id @default(uuid())
  owner_id    String
  name        String
  address     String
  city        String
  country     String
  description String?
  created_at  DateTime  @default(now())
  updated_at  DateTime  @updatedAt
  deleted_at  DateTime?

  owner            User             @relation(fields: [owner_id], references: [id])
  units            Unit[]
  expenses         Expense[]
  other_income     OtherIncome[]
  report_snapshots ReportSnapshot[]
  rent_charges     RentCharge[]

  // Soft-deleted houses excluded from plan limit count via deleted_at IS NULL in query
  @@index([owner_id, deleted_at])         // list active houses by owner
  @@index([owner_id])                     // COUNT for plan limit check
}

// ─── UNITS ────────────────────────────────────────────────────────────────────

model Unit {
  id          String    @id @default(uuid())
  house_id    String
  name        String                        // "Unit A", "Flat 3B", "Room 12"
  floor       String?
  bedrooms    Int       @default(1)
  bathrooms   Int       @default(1)
  description String?
  created_at  DateTime  @default(now())
  updated_at  DateTime  @updatedAt
  deleted_at  DateTime?

  house        House         @relation(fields: [house_id], references: [id])
  leases       Lease[]
  rent_rates   RentRate[]
  rent_charges RentCharge[]
  expenses     Expense[]
  other_income OtherIncome[]

  @@index([house_id, deleted_at])         // list active units in a house
  @@index([house_id])                     // unit count per house
}

// ─── TENANTS ──────────────────────────────────────────────────────────────────
//
// A tenant is a person profile owned by the landlord.
// Their connection to a house and unit lives in the lease table — not here.
// Query "who is in Unit A" via: leases WHERE unit_id = X AND status = ACTIVE
// Query "who has lived in House 1" via: leases WHERE house_id = X

model Tenant {
  id         String    @id @default(uuid())
  owner_id   String                        // landlord who created this tenant
  full_name  String
  email      String?
  phone      String?
  photo_url  String?                       // profile photo — R2 URL, small avatar image
  id_type    String?                       // "NATIONAL_ID" | "PASSPORT" | "DRIVING_LICENSE"
  id_number  String?
  notes      String?
  created_at DateTime  @default(now())
  updated_at DateTime  @updatedAt
  deleted_at DateTime?

  leases          Lease[]
  family_members  TenantFamilyMember[]
  attachments     Attachment[]             @relation("TenantAttachments")  // NID scans, PDFs, etc.

  @@index([owner_id, deleted_at])         // list tenants for a landlord
  @@index([owner_id, full_name])          // name search
  @@index([email])                        // email search
}

// ─── TENANT FAMILY MEMBERS ────────────────────────────────────────────────────
//
// Optional co-occupants listed against a tenant (spouse, children, etc).
// Purely informational — does not affect leases, billing, or occupancy.
// Deleted automatically when the parent tenant is hard-removed (cascade at app layer,
// since tenants are normally soft-deleted and family members go with them).

model TenantFamilyMember {
  id         String   @id @default(uuid())
  tenant_id  String
  name       String
  relation   String                        // "Spouse" | "Child" | "Parent" | "Sibling" | "Other"
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt

  tenant Tenant @relation(fields: [tenant_id], references: [id], onDelete: Cascade)

  @@index([tenant_id])
}

// ─── LEASES ───────────────────────────────────────────────────────────────────
//
// This is the source of truth for:
//   - which tenant lives in which unit (current occupancy)
//   - which house the unit belongs to
//   - the full move-in/move-out history per unit
//   - which tenants have ever lived in a house
//
// Current tenant for a unit = lease WHERE unit_id = X AND status = ACTIVE
// Tenant history = all leases WHERE tenant_id = X

model Lease {
  id               String      @id @default(uuid())
  house_id         String                        // denormalized for fast house-level queries
  unit_id          String
  tenant_id        String
  status           LeaseStatus @default(ACTIVE)
  start_date       DateTime
  end_date         DateTime?                     // contractual end date
  move_in_date     DateTime
  move_out_date    DateTime?                     // actual date tenant left
  security_deposit Decimal     @db.Decimal(14,2) @default(0)
  ended_reason     String?                       // "NATURAL_END" | "EARLY_TERMINATION" | "EVICTION"
  notes            String?
  created_at       DateTime    @default(now())
  updated_at       DateTime    @updatedAt

  house        House        @relation(fields: [house_id], references: [id])
  unit         Unit         @relation(fields: [unit_id], references: [id])
  tenant       Tenant       @relation(fields: [tenant_id], references: [id])
  rent_charges RentCharge[]
  attachments  Attachment[] @relation("LeaseAttachments")

  @@index([unit_id, status])              // find active tenant for a unit — most frequent query
  @@index([house_id, status])             // house occupancy overview
  @@index([tenant_id])                    // tenant's full lease history
  @@index([status, end_date])             // leases expiring soon
  @@index([house_id, tenant_id])          // has this tenant ever lived in this house?
}

// Database-level constraint: only one ACTIVE lease per unit
// Add via raw SQL migration (Prisma does not support partial indexes in schema):
// CREATE UNIQUE INDEX one_active_lease_per_unit ON leases(unit_id) WHERE status = 'ACTIVE';

enum LeaseStatus {
  ACTIVE
  ENDED
  TERMINATED
}

// ─── RENT RATES ───────────────────────────────────────────────────────────────
//
// Append-only rent history per unit.
// Current rate = rent_rates WHERE unit_id = X AND effective_to IS NULL
// Changing rent: close old row (set effective_to), insert new row (effective_to = null)
// Already-generated rent charges are NEVER changed — they hold their snapshot amount.

model RentRate {
  id             String    @id @default(uuid())
  unit_id        String
  amount         Decimal   @db.Decimal(14,2)
  effective_from DateTime
  effective_to   DateTime?                     // null = currently active rate
  set_by         String                        // user_id
  notes          String?
  created_at     DateTime  @default(now())

  unit Unit @relation(fields: [unit_id], references: [id])

  @@index([unit_id, effective_to])        // find active rate: WHERE effective_to IS NULL
  @@index([unit_id, effective_from])      // rate history in date order
}

// ─── RENT CHARGES ─────────────────────────────────────────────────────────────
//
// What a tenant owes for a given month.
// amount_due is a SNAPSHOT of the rent rate at generation time — never updated retroactively.
// status is a cached derived field, recomputed after every payment action.
// Multiple payments may exist per charge (partial, installments, overpayment).

model RentCharge {
  id          String           @id @default(uuid())
  house_id    String                              // denormalized for report queries
  unit_id     String
  lease_id    String
  tenant_id   String                              // denormalized for fast lookups
  due_month   String                              // "YYYY-MM" e.g. "2024-03"
  due_date    DateTime
  amount_due  Decimal          @db.Decimal(14,2)  // snapshot — never changed after creation
  status      RentChargeStatus @default(UNPAID)   // cached derived: recomputed after payments
  notes       String?
  voided_at   DateTime?
  void_reason String?
  created_at  DateTime         @default(now())
  updated_at  DateTime         @updatedAt

  house    House     @relation(fields: [house_id], references: [id])
  unit     Unit      @relation(fields: [unit_id], references: [id])
  lease    Lease     @relation(fields: [lease_id], references: [id])
  payments Payment[]

  @@unique([unit_id, lease_id, due_month])  // no duplicate charge per unit+lease+month
  @@index([house_id, due_month])            // monthly report: all charges for a house
  @@index([lease_id])                       // all charges for a lease
  @@index([tenant_id, due_month])           // tenant payment history by month
  @@index([status, due_date])               // cron: overdue detection scan
  @@index([house_id, status])               // dashboard: unpaid count per house
}

enum RentChargeStatus {
  UNPAID
  PARTIAL
  PAID
  OVERDUE
  VOIDED
}

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────
//
// Actual money received against a rent charge.
// Never deleted. Voided via status = VOIDED + void_reason + voided_at.
// Idempotency via unique idempotency_key — prevents duplicate submissions.
// After any payment mutation, recompute parent rent_charge.status.

model Payment {
  id              String        @id @default(uuid())
  rent_charge_id  String
  amount          Decimal       @db.Decimal(14,2)
  date_paid       DateTime
  method          PaymentMethod
  status          PaymentStatus @default(CONFIRMED)
  reference_no    String?
  idempotency_key String        @unique           // client-generated UUID, prevents duplicates
  recorded_by     String                          // user_id
  notes           String?
  void_reason     String?
  voided_at       DateTime?
  created_at      DateTime      @default(now())
  updated_at      DateTime      @updatedAt

  rent_charge RentCharge   @relation(fields: [rent_charge_id], references: [id])
  attachments Attachment[] @relation("PaymentAttachments")

  @@index([rent_charge_id, status])       // SUM confirmed payments for a charge
  @@index([date_paid])                    // date-range reports
  @@index([status, date_paid])            // filter confirmed payments in a period
  @@index([recorded_by])                  // audit: what did this user record
}

enum PaymentMethod {
  CASH
  BANK_TRANSFER
  MOBILE_MONEY
  CHEQUE
  CARD
  OTHER
}

enum PaymentStatus {
  CONFIRMED
  VOIDED
  REFUNDED
}

// ─── EXPENSES ─────────────────────────────────────────────────────────────────
//
// Landlord spending at house level (unit_id = null) or unit level (unit_id set).
// Soft deleted — financial history preserved.
// If category = OTHER, custom_category is required (enforced in service layer).

model Expense {
  id              String          @id @default(uuid())
  house_id        String
  unit_id         String?                         // null = house-level expense
  category        ExpenseCategory
  custom_category String?                         // required when category = OTHER
  amount          Decimal         @db.Decimal(14,2)
  expense_date    DateTime
  description     String?
  vendor          String?
  created_by      String                          // user_id
  created_at      DateTime        @default(now())
  updated_at      DateTime        @updatedAt
  deleted_at      DateTime?                       // soft delete

  house       House        @relation(fields: [house_id], references: [id])
  unit        Unit?        @relation(fields: [unit_id], references: [id])
  attachments Attachment[] @relation("ExpenseAttachments")

  @@index([house_id, expense_date, deleted_at])  // report: sum expenses in a period
  @@index([house_id, category])                  // filter by category
  @@index([unit_id, expense_date])               // unit-level expense history
}

enum ExpenseCategory {
  MAINTENANCE
  UTILITIES
  INSURANCE
  PROPERTY_TAX
  MANAGEMENT_FEE
  CLEANING
  LANDSCAPING
  LEGAL
  MARKETING
  SUPPLIES
  RENOVATION
  OTHER
}

// ─── OTHER INCOME ─────────────────────────────────────────────────────────────
//
// Income that is not rent — parking, laundry, late fees, etc.
// Supports house-level (unit_id = null) and unit-level income.

model OtherIncome {
  id          String          @id @default(uuid())
  house_id    String
  unit_id     String?                         // null = house-level income
  type        OtherIncomeType
  amount      Decimal         @db.Decimal(14,2)
  income_date DateTime
  description String?
  created_by  String
  created_at  DateTime        @default(now())
  updated_at  DateTime        @updatedAt
  deleted_at  DateTime?

  house       House        @relation(fields: [house_id], references: [id])
  unit        Unit?        @relation(fields: [unit_id], references: [id])
  attachments Attachment[] @relation("OtherIncomeAttachments")

  @@index([house_id, income_date, deleted_at])  // report: sum income in a period
  @@index([house_id, type])                     // filter by income type
}

enum OtherIncomeType {
  PARKING
  LAUNDRY
  LATE_FEE
  PET_FEE
  STORAGE
  SECURITY_DEPOSIT_FORFEITURE
  UTILITY_REIMBURSEMENT
  OTHER
}

// ─── ATTACHMENTS ──────────────────────────────────────────────────────────────
//
// Files linked to payments, expenses, leases, other_income, or tenants.
// Uploaded directly to Cloudflare R2 via presigned URL — never through the API server.
// Polymorphic: owner_type + owner_id identify the parent entity.
//
// Tenant attachments cover NID scans, passport copies, and lease-related tenant
// documents. mime_type allows both images (image/jpeg, image/png) and PDFs
// (application/pdf) — the UI should accept either at upload time.

model Attachment {
  id              String    @id @default(uuid())
  owner_type      String                          // "payment" | "expense" | "lease" | "other_income" | "tenant"
  owner_id        String
  document_type   String?                         // "NID" | "PASSPORT" | "RECEIPT" | "BILL" | "LEASE_DOC" | "OTHER" — mainly used for tenant docs
  file_key        String    @unique               // R2 object key
  file_url        String                          // public or presigned URL
  file_name       String
  mime_type       String                          // image/jpeg, image/png, application/pdf, etc.
  size_bytes      Int
  uploaded_by     String                          // user_id
  created_at      DateTime  @default(now())
  deleted_at      DateTime?

  payment         Payment?     @relation("PaymentAttachments",    fields: [payment_id],      references: [id])
  payment_id      String?
  expense         Expense?     @relation("ExpenseAttachments",    fields: [expense_id],      references: [id])
  expense_id      String?
  lease           Lease?       @relation("LeaseAttachments",      fields: [lease_id],        references: [id])
  lease_id        String?
  other_income    OtherIncome? @relation("OtherIncomeAttachments", fields: [other_income_id], references: [id])
  other_income_id String?
  tenant          Tenant?      @relation("TenantAttachments",      fields: [tenant_id],       references: [id])
  tenant_id       String?

  @@index([owner_type, owner_id])         // fetch all attachments for any entity
  @@index([tenant_id, document_type])     // fetch a tenant's NID/passport docs specifically
  @@index([deleted_at])                   // orphan cleanup: find old deleted attachments
}

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────────
//
// Append-only. No update or delete endpoints ever exposed.
// Written after every meaningful mutation: CREATE, UPDATE, DELETE, VOID, REFUND, etc.
// before_state and after_state stored as JSON snapshots.

model AuditLog {
  id           String      @id @default(uuid())
  entity_type  String                          // "payment" | "lease" | "expense" | "rent_charge" ...
  entity_id    String
  action       AuditAction
  actor_id     String                          // user_id
  before_state Json?
  after_state  Json?
  ip_address   String?
  user_agent   String?
  created_at   DateTime    @default(now())

  actor User @relation("AuditActor", fields: [actor_id], references: [id])

  @@index([entity_type, entity_id])       // full history for one record
  @@index([actor_id, created_at])         // what did this user do and when
  @@index([created_at])                   // time-range audit queries
  @@index([action, entity_type])          // filter: all VOIDs across payments
}

enum AuditAction {
  CREATE
  UPDATE
  DELETE
  RESTORE
  VOID
  REFUND
  MOVE_IN
  MOVE_OUT
  GENERATE
  RECALCULATE
}

// ─── REPORT SNAPSHOTS ─────────────────────────────────────────────────────────
//
// Cached monthly and yearly reports per house.
// Current month: always computed live.
// Past months: computed once, stored here, served from cache.
// If a historical payment or expense changes: is_final = false, recomputed on next request.

model ReportSnapshot {
  id                   String     @id @default(uuid())
  house_id             String
  period_type          PeriodType
  period_key           String                        // "2024-03" (monthly) or "2024" (yearly)
  total_rent_collected Decimal    @db.Decimal(14,2)
  total_other_income   Decimal    @db.Decimal(14,2)
  total_expenses       Decimal    @db.Decimal(14,2)
  net_income           Decimal    @db.Decimal(14,2)
  occupied_units       Int
  vacant_units         Int
  overdue_amount       Decimal    @db.Decimal(14,2)
  rent_roll            Json                          // per-unit detail array
  data                 Json                          // full raw report payload
  is_final             Boolean    @default(false)
  generated_at         DateTime   @default(now())
  updated_at           DateTime   @updatedAt

  house House @relation(fields: [house_id], references: [id])

  @@unique([house_id, period_type, period_key])
  @@index([house_id, period_key])         // fetch report for a house + period
  @@index([is_final, period_key])         // find stale snapshots needing recalculation
}

enum PeriodType {
  MONTHLY
  YEARLY
}

// ─── RATE LIMIT TOKENS ────────────────────────────────────────────────────────
//
// DB-native rate limiting. No Redis needed.
// A sliding window token bucket per user per endpoint group.
// Rows older than 1 hour are irrelevant and cleaned by the overdue cron job.

model RateLimitToken {
  id         String   @id @default(uuid())
  key        String                          // "{user_id}:{endpoint_group}"
  created_at DateTime @default(now())

  @@index([key, created_at])              // count requests in last N seconds
}
```

### Raw SQL Migrations to Run After `prisma migrate dev`

```sql
-- 1. One active lease per unit (partial unique index — Prisma cannot express this)
CREATE UNIQUE INDEX one_active_lease_per_unit
  ON leases(unit_id)
  WHERE status = 'ACTIVE';

-- 2. One active rent rate per unit (partial unique index)
CREATE UNIQUE INDEX one_active_rent_rate_per_unit
  ON rent_rates(unit_id)
  WHERE effective_to IS NULL;

-- 3. Auto-cleanup old rate limit tokens (keeps table small)
-- Run as a periodic DELETE in the overdue cron, not a trigger
-- DELETE FROM rate_limit_tokens WHERE created_at < NOW() - INTERVAL '2 hours';
```

---

## 5. Index Strategy — Why Each Index Exists

| Table | Index | Query It Serves |
|---|---|---|
| `users` | `(email)` | Login — called on every auth request |
| `houses` | `(owner_id, deleted_at)` | Dashboard: list active houses |
| `houses` | `(owner_id)` | COUNT for plan limit enforcement |
| `leases` | `(unit_id, status)` | **Most frequent**: find current tenant for a unit |
| `leases` | `(house_id, status)` | Occupancy count for house dashboard |
| `leases` | `(tenant_id)` | Tenant's full move history |
| `leases` | `(status, end_date)` | Leases expiring soon |
| `rent_rates` | `(unit_id, effective_to)` | Find active rate: `effective_to IS NULL` |
| `rent_charges` | `(house_id, due_month)` | **Heavy**: monthly report aggregation |
| `rent_charges` | `(status, due_date)` | Cron: overdue detection scan |
| `rent_charges` | `(house_id, status)` | Dashboard: unpaid charges count |
| `payments` | `(rent_charge_id, status)` | SUM confirmed payments for a charge |
| `payments` | `(date_paid)` | Date-range financial reports |
| `expenses` | `(house_id, expense_date, deleted_at)` | Report: expense total in period |
| `other_income` | `(house_id, income_date, deleted_at)` | Report: income total in period |
| `audit_logs` | `(entity_type, entity_id)` | Full history for one record |
| `report_snapshots` | `(is_final, period_key)` | Find stale reports to refresh |
| `rate_limit_tokens` | `(key, created_at)` | Count requests in sliding window |
| `tenant_family_members` | `(tenant_id)` | Fetch family list on tenant profile |
| `attachments` | `(tenant_id, document_type)` | Fetch a tenant's NID/passport scans specifically |

---

## 6. Project Structure

```
tenant-saas/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   │
│   ├── (dashboard)/
│   │   ├── layout.tsx                    # App shell: sidebar + topbar
│   │   ├── page.tsx                      # Overview dashboard
│   │   ├── houses/
│   │   │   ├── page.tsx                  # Houses list
│   │   │   └── [houseId]/
│   │   │       ├── page.tsx              # House detail
│   │   │       ├── units/
│   │   │       │   ├── page.tsx          # Units grid
│   │   │       │   └── [unitId]/page.tsx # Unit detail + tenant + payments
│   │   │       ├── expenses/page.tsx
│   │   │       ├── income/page.tsx
│   │   │       └── reports/page.tsx
│   │   ├── tenants/
│   │   │   ├── page.tsx                  # All tenants (landlord-wide)
│   │   │   └── [tenantId]/page.tsx       # Tenant profile + lease history
│   │   ├── payments/page.tsx             # All payments across portfolio
│   │   └── settings/
│   │       ├── page.tsx
│   │       └── subscription/page.tsx
│   │
│   └── api/
│       ├── auth/
│       │   └── [...nextauth]/route.ts
│       ├── v1/
│       │   ├── houses/
│       │   │   ├── route.ts              # GET list, POST create
│       │   │   └── [houseId]/
│       │   │       ├── route.ts          # GET, PATCH, DELETE
│       │   │       └── units/
│       │   │           ├── route.ts      # GET list, POST create
│       │   │           └── [unitId]/
│       │   │               ├── route.ts  # GET, PATCH, DELETE
│       │   │               └── current-tenant/route.ts
│       │   ├── tenants/
│       │   │   ├── route.ts
│       │   │   └── [tenantId]/route.ts
│       │   ├── leases/
│       │   │   ├── route.ts
│       │   │   └── [leaseId]/
│       │   │       ├── route.ts
│       │   │       └── end/route.ts
│       │   ├── rent-rates/
│       │   │   └── route.ts
│       │   ├── rent-charges/
│       │   │   ├── route.ts
│       │   │   └── [id]/
│       │   │       ├── route.ts
│       │   │       └── void/route.ts
│       │   ├── payments/
│       │   │   ├── route.ts
│       │   │   └── [id]/
│       │   │       ├── route.ts
│       │   │       ├── void/route.ts
│       │   │       └── refund/route.ts
│       │   ├── expenses/
│       │   │   ├── route.ts
│       │   │   └── [id]/route.ts
│       │   ├── other-income/
│       │   │   ├── route.ts
│       │   │   └── [id]/route.ts
│       │   ├── reports/
│       │   │   ├── monthly/route.ts
│       │   │   └── yearly/route.ts
│       │   ├── attachments/
│       │   │   ├── presign/route.ts
│       │   │   └── confirm/route.ts
│       │   ├── audit-logs/route.ts
│       │   └── subscription/route.ts
│       │
│       └── cron/
│           ├── generate-rent-charges/route.ts   # 1st of month
│           └── detect-overdue/route.ts          # daily
│
├── lib/
│   ├── prisma.ts           # Serverless-safe Prisma singleton
│   ├── auth.ts             # NextAuth config
│   ├── r2.ts               # Cloudflare R2 client
│   ├── resend.ts           # Email via Resend
│   ├── audit.ts            # writeAuditLog() helper
│   ├── rate-limit.ts       # DB-native token bucket
│   └── decimal.ts          # Decimal.js helpers (never use parseFloat for money)
│
├── services/               # Pure business logic — no HTTP, no NextRequest
│   ├── house.service.ts
│   ├── unit.service.ts
│   ├── tenant.service.ts
│   ├── lease.service.ts
│   ├── rent-rate.service.ts
│   ├── rent-charge.service.ts
│   ├── payment.service.ts
│   ├── expense.service.ts
│   ├── other-income.service.ts
│   ├── report.service.ts
│   └── subscription.service.ts
│
├── schemas/                # Zod validation schemas
│   ├── house.schema.ts
│   ├── lease.schema.ts
│   ├── payment.schema.ts
│   ├── expense.schema.ts
│   └── ...
│
├── types/
│   └── index.ts
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│       └── 0001_init/
│           └── migration.sql   # includes partial indexes
│
└── vercel.json
```

---

## 7. Core Library Files

### Prisma Singleton (Serverless-Safe)

```typescript
// lib/prisma.ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
```

### DB-Native Rate Limiter

```typescript
// lib/rate-limit.ts
import { prisma } from './prisma'

export async function checkRateLimit(
  userId: string,
  group: 'default' | 'auth' | 'upload',
  limits = { default: 100, auth: 10, upload: 20 },
  windowSeconds = 60
): Promise<{ allowed: boolean; remaining: number }> {
  const key = `${userId}:${group}`
  const windowStart = new Date(Date.now() - windowSeconds * 1000)
  const limit = limits[group]

  // Count requests in the sliding window
  const count = await prisma.rateLimitToken.count({
    where: { key, created_at: { gte: windowStart } },
  })

  if (count >= limit) {
    return { allowed: false, remaining: 0 }
  }

  // Record this request
  await prisma.rateLimitToken.create({ data: { key } })

  return { allowed: true, remaining: limit - count - 1 }
}
```

### Audit Log Helper

```typescript
// lib/audit.ts
import { prisma } from './prisma'
import { AuditAction } from '@prisma/client'

interface AuditEntry {
  entity_type: string
  entity_id: string
  action: AuditAction
  actor_id: string
  before_state?: object
  after_state?: object
  ip_address?: string
  user_agent?: string
}

export async function writeAuditLog(entry: AuditEntry) {
  await prisma.auditLog.create({ data: entry })
}
```

### Decimal Helper

```typescript
// lib/decimal.ts
import { Decimal } from 'decimal.js'

// Always use this — never parseFloat() for money
export function toDecimal(value: string | number): Decimal {
  return new Decimal(value)
}

export function sumDecimals(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.add(v), new Decimal(0))
}

export function formatMoney(value: Decimal | string): string {
  return new Decimal(value).toFixed(2)
}
```

### Resend Email

```typescript
// lib/resend.ts
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

export async function sendPaymentReminder({
  to,
  tenantName,
  unitName,
  houseName,
  amountDue,
  dueDate,
}: {
  to: string
  tenantName: string
  unitName: string
  houseName: string
  amountDue: string
  dueDate: string
}) {
  await resend.emails.send({
    from: 'noreply@yourdomain.com',
    to,
    subject: `Rent reminder — ${unitName}, ${houseName}`,
    html: `
      <p>Hi ${tenantName},</p>
      <p>This is a reminder that your rent of <strong>${amountDue}</strong>
         is due on <strong>${dueDate}</strong> for ${unitName} at ${houseName}.</p>
      <p>Please contact your landlord if you have any questions.</p>
    `,
  })
}
```

---

## 8. API Route Patterns

### Auth Guard Middleware

```typescript
// lib/auth-guard.ts
import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { authOptions } from './auth'

export async function requireSession() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return { session: null, error: NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 }) }
  }
  return { session, error: null }
}
```

### Houses Route — Full Example

```typescript
// app/api/v1/houses/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth-guard'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/prisma'
import { writeAuditLog } from '@/lib/audit'
import { createHouseSchema } from '@/schemas/house.schema'

export async function GET(req: NextRequest) {
  const { session, error } = await requireSession()
  if (error) return error

  const houses = await prisma.house.findMany({
    where: { owner_id: session.user.id, deleted_at: null },
    include: {
      _count: {
        select: { units: { where: { deleted_at: null } } },
      },
    },
    orderBy: { created_at: 'desc' },
  })

  // Enrich with occupancy counts
  const data = await Promise.all(
    houses.map(async (house) => {
      const [occupied, vacant] = await Promise.all([
        prisma.lease.count({ where: { house_id: house.id, status: 'ACTIVE' } }),
        prisma.unit.count({
          where: {
            house_id: house.id,
            deleted_at: null,
            leases: { none: { status: 'ACTIVE' } },
          },
        }),
      ])
      return { ...house, occupied_units: occupied, vacant_units: vacant }
    })
  )

  return NextResponse.json({ data, total: data.length })
}

export async function POST(req: NextRequest) {
  const { session, error } = await requireSession()
  if (error) return error

  const { allowed } = await checkRateLimit(session.user.id, 'default')
  if (!allowed) return NextResponse.json({ error: 'TOO_MANY_REQUESTS' }, { status: 429 })

  const body = await req.json()
  const parsed = createHouseSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Plan limit check — in service layer, not just controller
  const [activeCount, subscription] = await Promise.all([
    prisma.house.count({ where: { owner_id: session.user.id, deleted_at: null } }),
    prisma.subscription.findUnique({
      where: { user_id: session.user.id },
      include: { plan: true },
    }),
  ])

  const maxHouses = subscription?.plan.max_houses ?? 2
  if (activeCount >= maxHouses) {
    return NextResponse.json(
      { error: 'HOUSE_LIMIT_REACHED', limit: maxHouses, current: activeCount },
      { status: 403 }
    )
  }

  const house = await prisma.house.create({
    data: { ...parsed.data, owner_id: session.user.id },
  })

  await writeAuditLog({
    entity_type: 'house',
    entity_id: house.id,
    action: 'CREATE',
    actor_id: session.user.id,
    after_state: house,
    ip_address: req.headers.get('x-forwarded-for') ?? undefined,
  })

  return NextResponse.json(house, { status: 201 })
}
```

### Payment Route — Idempotency Example

```typescript
// app/api/v1/payments/route.ts
export async function POST(req: NextRequest) {
  const { session, error } = await requireSession()
  if (error) return error

  const body = await req.json()
  const parsed = createPaymentSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 400 })
  }

  // Check idempotency — return existing payment if key already used
  const existing = await prisma.payment.findUnique({
    where: { idempotency_key: parsed.data.idempotency_key },
  })
  if (existing) {
    return NextResponse.json(existing, { status: 200 }) // 200 not 201 = already existed
  }

  // Verify rent charge belongs to this owner
  const charge = await prisma.rentCharge.findFirst({
    where: {
      id: parsed.data.rent_charge_id,
      house: { owner_id: session.user.id },
    },
  })
  if (!charge) return NextResponse.json({ error: 'RENT_CHARGE_NOT_FOUND' }, { status: 404 })
  if (charge.voided_at) return NextResponse.json({ error: 'RENT_CHARGE_VOIDED' }, { status: 409 })

  // Create payment + recompute charge status in a transaction
  const payment = await prisma.$transaction(async (tx) => {
    const newPayment = await tx.payment.create({
      data: {
        ...parsed.data,
        recorded_by: session.user.id,
      },
    })

    // Recompute total paid for this charge
    const agg = await tx.payment.aggregate({
      where: { rent_charge_id: charge.id, status: 'CONFIRMED' },
      _sum: { amount: true },
    })

    const totalPaid = agg._sum.amount ?? new Decimal(0)
    const amountDue = new Decimal(charge.amount_due.toString())

    let newStatus: RentChargeStatus = 'UNPAID'
    if (totalPaid.gte(amountDue)) newStatus = 'PAID'
    else if (totalPaid.gt(0)) newStatus = 'PARTIAL'

    await tx.rentCharge.update({
      where: { id: charge.id },
      data: { status: newStatus },
    })

    return newPayment
  })

  await writeAuditLog({
    entity_type: 'payment',
    entity_id: payment.id,
    action: 'CREATE',
    actor_id: session.user.id,
    after_state: payment,
    ip_address: req.headers.get('x-forwarded-for') ?? undefined,
  })

  return NextResponse.json(payment, { status: 201 })
}
```

### Unit Current Tenant — Derived Query

```typescript
// app/api/v1/houses/[houseId]/units/[unitId]/current-tenant/route.ts
export async function GET(
  req: NextRequest,
  { params }: { params: { houseId: string; unitId: string } }
) {
  const { session, error } = await requireSession()
  if (error) return error

  // Verify ownership
  const unit = await prisma.unit.findFirst({
    where: {
      id: params.unitId,
      house_id: params.houseId,
      house: { owner_id: session.user.id },
      deleted_at: null,
    },
  })
  if (!unit) return NextResponse.json({ error: 'UNIT_NOT_FOUND' }, { status: 404 })

  // Current tenant derived from active lease
  const activeLease = await prisma.lease.findFirst({
    where: { unit_id: unit.id, status: 'ACTIVE' },
    include: {
      tenant: true,
      rent_charges: {
        orderBy: { due_month: 'desc' },
        take: 3,
        include: {
          payments: { where: { status: 'CONFIRMED' } },
        },
      },
    },
  })

  if (!activeLease) {
    return NextResponse.json({ occupied: false, tenant: null, lease: null })
  }

  return NextResponse.json({
    occupied: true,
    tenant: activeLease.tenant,
    lease: {
      id: activeLease.id,
      move_in_date: activeLease.move_in_date,
      end_date: activeLease.end_date,
      security_deposit: activeLease.security_deposit,
    },
    recent_charges: activeLease.rent_charges,
  })
}
```

---

## 9. Cron Jobs (2 only — Vercel Hobby free tier)

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/cron/generate-rent-charges",
      "schedule": "5 0 1 * *"
    },
    {
      "path": "/api/cron/detect-overdue",
      "schedule": "0 6 * * *"
    }
  ]
}
```

### Cron 1: Generate Monthly Rent Charges

```typescript
// app/api/cron/generate-rent-charges/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { writeAuditLog } from '@/lib/audit'
import { format, startOfMonth, addMonths } from 'date-fns'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const dueMonth = format(now, 'yyyy-MM')
  const dueDate = startOfMonth(now)

  // Get all active leases with their current rent rate
  const activeLeases = await prisma.lease.findMany({
    where: { status: 'ACTIVE' },
    include: {
      unit: {
        include: {
          rent_rates: {
            where: { effective_to: null },
            take: 1,
          },
        },
      },
    },
  })

  let generated = 0
  let skipped = 0

  for (const lease of activeLeases) {
    const activeRate = lease.unit.rent_rates[0]
    if (!activeRate) {
      skipped++
      continue // no rent rate set for this unit — skip
    }

    try {
      // createMany with skipDuplicates respects the unique constraint (unit_id, lease_id, due_month)
      const result = await prisma.rentCharge.createMany({
        data: [{
          house_id: lease.house_id,
          unit_id: lease.unit_id,
          lease_id: lease.id,
          tenant_id: lease.tenant_id,
          due_month: dueMonth,
          due_date: dueDate,
          amount_due: activeRate.amount,
          status: 'UNPAID',
        }],
        skipDuplicates: true,
      })

      if (result.count > 0) {
        generated++
        await writeAuditLog({
          entity_type: 'rent_charge',
          entity_id: `${lease.unit_id}:${dueMonth}`,
          action: 'GENERATE',
          actor_id: 'system',
          after_state: { due_month: dueMonth, amount_due: activeRate.amount },
        })
      } else {
        skipped++ // already existed
      }
    } catch {
      skipped++
    }
  }

  return NextResponse.json({ generated, skipped, due_month: dueMonth })
}
```

### Cron 2: Detect Overdue + Send Reminders

```typescript
// app/api/cron/detect-overdue/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendPaymentReminder } from '@/lib/resend'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date()

  // 1. Mark overdue charges
  const overdueResult = await prisma.rentCharge.updateMany({
    where: {
      status: { in: ['UNPAID', 'PARTIAL'] },
      due_date: { lt: today },
      voided_at: null,
    },
    data: { status: 'OVERDUE' },
  })

  // 2. Send reminders: charges due in 3 days (upcoming) or newly overdue (1 day past)
  const threeDaysFromNow = new Date(today)
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3)

  const upcomingCharges = await prisma.rentCharge.findMany({
    where: {
      status: 'UNPAID',
      due_date: {
        gte: today,
        lte: threeDaysFromNow,
      },
    },
    include: {
      lease: {
        include: { tenant: true },
      },
      unit: true,
      house: true,
    },
  })

  let remindersSent = 0
  for (const charge of upcomingCharges) {
    const email = charge.lease.tenant.email
    if (!email) continue

    await sendPaymentReminder({
      to: email,
      tenantName: charge.lease.tenant.full_name,
      unitName: charge.unit.name,
      houseName: charge.house.name,
      amountDue: charge.amount_due.toString(),
      dueDate: charge.due_date.toDateString(),
    })
    remindersSent++
  }

  return NextResponse.json({
    marked_overdue: overdueResult.count,
    reminders_sent: remindersSent,
  })
}
```

### Subscription Check and Report Recalculation

These are **not cron jobs** on Vercel free tier. Instead:

- **Subscription status**: checked lazily on every login — if `current_period_end < now` and status is ACTIVE, mark as PAST_DUE at that moment
- **Report recalculation**: triggered on demand when a user requests a report and `is_final = false`, or when a payment/expense is voided (mark snapshot stale, recompute on next GET)

---

## 10. UI Orchestration Endpoints

The screens use simplified forms that hide multi-table complexity from the landlord. These endpoints wrap several writes in a single transaction so the UI never has to make three separate calls to accomplish one user action.

### 10a. Create Unit — auto-creates the first Rent Rate

The "Add Unit" form only asks for **Unit Name** and **Monthly Rent**. Under the hood this must create both the `Unit` and its first `RentRate` row so the rent-history model stays intact from day one.

```typescript
// services/unit.service.ts
export async function createUnit(houseId: string, ownerId: string, input: {
  name: string
  monthly_rent: string
  floor?: string
  bedrooms?: number
  bathrooms?: number
}) {
  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
  })
  if (!house) throw new NotFoundError('HOUSE_NOT_FOUND')

  return prisma.$transaction(async (tx) => {
    const unit = await tx.unit.create({
      data: {
        house_id: houseId,
        name: input.name,
        floor: input.floor,
        bedrooms: input.bedrooms ?? 1,
        bathrooms: input.bathrooms ?? 1,
      },
    })

    await tx.rentRate.create({
      data: {
        unit_id: unit.id,
        amount: input.monthly_rent,
        effective_from: new Date(),
        effective_to: null,
        set_by: ownerId,
      },
    })

    return unit
  })
}
```

Editing a unit's rent later (via `PATCH .../units/:unitId`) goes through the same close-old / open-new rent rate logic already defined in the schema — never an in-place update of the amount.

### 10b. Create Tenant — combined onboarding (Tenant + Lease)

The "Add Tenant" form collects tenant details **and** unit assignment **and** lease dates in one screen. The backend creates a `Tenant`, then a matching `Lease`, in a single transaction — so a tenant can never exist in a "half-onboarded" state with no lease.

```typescript
// services/tenant.service.ts
export async function onboardTenant(ownerId: string, input: {
  full_name: string
  national_id?: string
  phone?: string
  email?: string
  photo_url?: string
  unit_id: string
  move_in_date: string
  lease_end?: string
  security_deposit?: string
  family_members?: { name: string; relation: string }[]
}) {
  const unit = await prisma.unit.findFirst({
    where: { id: input.unit_id, house: { owner_id: ownerId }, deleted_at: null },
    include: { house: true },
  })
  if (!unit) throw new NotFoundError('UNIT_NOT_FOUND')

  const activeLease = await prisma.lease.findFirst({
    where: { unit_id: unit.id, status: 'ACTIVE' },
  })
  if (activeLease) throw new ConflictError('UNIT_ALREADY_OCCUPIED')

  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        owner_id: ownerId,
        full_name: input.full_name,
        id_number: input.national_id,
        id_type: input.national_id ? 'NATIONAL_ID' : null,
        phone: input.phone,
        email: input.email,
        photo_url: input.photo_url,
      },
    })

    const lease = await tx.lease.create({
      data: {
        house_id: unit.house_id,
        unit_id: unit.id,
        tenant_id: tenant.id,
        status: 'ACTIVE',
        start_date: new Date(input.move_in_date),
        end_date: input.lease_end ? new Date(input.lease_end) : null,
        move_in_date: new Date(input.move_in_date),
        security_deposit: input.security_deposit ?? '0',
      },
    })

    if (input.family_members?.length) {
      await tx.tenantFamilyMember.createMany({
        data: input.family_members.map((m) => ({
          tenant_id: tenant.id,
          name: m.name,
          relation: m.relation,
        })),
      })
    }

    return { tenant, lease }
  })
}
```

> **Note on the "Status" dropdown in the Add Tenant form (Active / etc.):** this is not a mutable field on the tenant row — it maps directly to `lease.status`. Selecting anything other than "Active" at creation time is unusual (a lease should start active), so the UI can default it and hide the field, or use it only to pick between `ACTIVE` and `TERMINATED` for backdated/historical data entry.

### 10c. Record Payment — resolves the Rent Charge automatically

The "Add Payment" form only asks for **Unit, Tenant, Amount, Date, Status** — no rent-charge picker. The service resolves (or creates) the correct month's `RentCharge` before writing the `Payment`, so the append-only charge/payment model stays intact without the landlord ever seeing it.

```typescript
// services/payment.service.ts
import { format, startOfMonth } from 'date-fns'

export async function recordSimplePayment(ownerId: string, input: {
  unit_id: string
  tenant_id: string
  amount: string
  date_paid: string
  method?: PaymentMethod
  idempotency_key: string
  status?: 'PAID' | 'PARTIAL' // from the UI's Status dropdown — informational only
}) {
  const existing = await prisma.payment.findUnique({
    where: { idempotency_key: input.idempotency_key },
  })
  if (existing) return existing // idempotent replay

  const lease = await prisma.lease.findFirst({
    where: {
      unit_id: input.unit_id,
      tenant_id: input.tenant_id,
      status: 'ACTIVE',
      unit: { house: { owner_id: ownerId } },
    },
    include: {
      unit: { include: { rent_rates: { where: { effective_to: null }, take: 1 } } },
    },
  })
  if (!lease) throw new NotFoundError('ACTIVE_LEASE_NOT_FOUND')

  const dueMonth = format(new Date(input.date_paid), 'yyyy-MM')
  const dueDate = startOfMonth(new Date(input.date_paid))
  const rate = lease.unit.rent_rates[0]

  return prisma.$transaction(async (tx) => {
    // find-or-create the month's rent charge
    let charge = await tx.rentCharge.findUnique({
      where: { unit_id_lease_id_due_month: { unit_id: lease.unit_id, lease_id: lease.id, due_month: dueMonth } },
    })

    if (!charge) {
      charge = await tx.rentCharge.create({
        data: {
          house_id: lease.house_id,
          unit_id: lease.unit_id,
          lease_id: lease.id,
          tenant_id: lease.tenant_id,
          due_month: dueMonth,
          due_date: dueDate,
          amount_due: rate?.amount ?? input.amount, // fall back to payment amount if no rate set
          status: 'UNPAID',
        },
      })
    }

    const payment = await tx.payment.create({
      data: {
        rent_charge_id: charge.id,
        amount: input.amount,
        date_paid: new Date(input.date_paid),
        method: input.method ?? 'CASH',
        idempotency_key: input.idempotency_key,
        recorded_by: ownerId,
      },
    })

    // recompute charge status from confirmed payments
    const agg = await tx.payment.aggregate({
      where: { rent_charge_id: charge.id, status: 'CONFIRMED' },
      _sum: { amount: true },
    })
    const totalPaid = new Decimal(agg._sum.amount?.toString() ?? '0')
    const amountDue = new Decimal(charge.amount_due.toString())
    const newStatus = totalPaid.gte(amountDue) ? 'PAID' : totalPaid.gt(0) ? 'PARTIAL' : 'UNPAID'

    await tx.rentCharge.update({ where: { id: charge.id }, data: { status: newStatus } })

    return payment
  })
}
```

### 10d. Dashboard — single aggregate query

Powers the "Rent Collection %", "Awaiting Payment", "Paid This Month", and "Expenses This Month" cards in one round trip.

```typescript
// services/dashboard.service.ts
export async function getDashboard(houseId: string, ownerId: string, monthKey?: string) {
  const house = await prisma.house.findFirst({ where: { id: houseId, owner_id: ownerId, deleted_at: null } })
  if (!house) throw new NotFoundError('HOUSE_NOT_FOUND')

  const period = monthKey ?? format(new Date(), 'yyyy-MM')

  const charges = await prisma.rentCharge.findMany({
    where: { house_id: houseId, due_month: period, voided_at: null },
    include: {
      payments: { where: { status: 'CONFIRMED' } },
      unit: true,
      lease: { include: { tenant: true } },
    },
  })

  const expensesAgg = await prisma.expense.aggregate({
    where: { house_id: houseId, expense_date: { gte: startOfMonth(new Date(`${period}-01`)) }, deleted_at: null },
    _sum: { amount: true },
  })

  const totalDue = charges.reduce((s, c) => s.add(new Decimal(c.amount_due.toString())), new Decimal(0))
  const totalCollected = charges.reduce((s, c) => {
    const paid = c.payments.reduce((ps, p) => ps.add(new Decimal(p.amount.toString())), new Decimal(0))
    return s.add(paid)
  }, new Decimal(0))

  const totalExpenses = new Decimal(expensesAgg._sum.amount?.toString() ?? '0')
  const paidUnits = charges.filter((c) => c.status === 'PAID').length
  const outstandingUnits = charges.length - paidUnits

  return {
    period,
    rent_collection: {
      collected: totalCollected.toFixed(2),
      total_due: totalDue.toFixed(2),
      percent: totalDue.gt(0) ? totalCollected.div(totalDue).mul(100).toFixed(0) : '0',
      units_paid: paidUnits,
      units_total: charges.length,
      outstanding: outstandingUnits,
    },
    expenses: { total: totalExpenses.toFixed(2), count: /* fetched separately or via _count */ 0 },
    net_income: totalCollected.sub(totalExpenses).toFixed(2),
    awaiting_payment: charges
      .filter((c) => c.status !== 'PAID')
      .map((c) => ({
        unit_name: c.unit.name,
        tenant_name: c.lease.tenant.full_name,
        amount_due: c.amount_due.toString(),
        status: c.status,
      })),
    paid_this_month: charges
      .filter((c) => c.status === 'PAID')
      .map((c) => ({
        unit_name: c.unit.name,
        tenant_name: c.lease.tenant.full_name,
        amount: c.amount_due.toString(),
        paid_date: c.payments[0]?.date_paid,
      })),
  }
}
```

---

## 11. Report Logic — Lazy Computation

```typescript
// services/report.service.ts
import { prisma } from '@/lib/prisma'
import { Decimal } from 'decimal.js'

export async function getMonthlyReport(houseId: string, periodKey: string, ownerId: string) {
  const isCurrentMonth = periodKey === format(new Date(), 'yyyy-MM')

  // For past months: check if a valid final snapshot exists
  if (!isCurrentMonth) {
    const snapshot = await prisma.reportSnapshot.findUnique({
      where: { house_id_period_type_period_key: { house_id: houseId, period_type: 'MONTHLY', period_key: periodKey } },
    })
    if (snapshot?.is_final) return snapshot
  }

  // Compute live (current month always, past months if snapshot is stale or missing)
  const [startDate, endDate] = getMonthBounds(periodKey)

  const [charges, expenses, otherIncome, units] = await Promise.all([
    prisma.rentCharge.findMany({
      where: { house_id: houseId, due_month: periodKey, voided_at: null },
      include: { payments: { where: { status: 'CONFIRMED' } }, unit: true, lease: { include: { tenant: true } } },
    }),
    prisma.expense.aggregate({
      where: { house_id: houseId, expense_date: { gte: startDate, lte: endDate }, deleted_at: null },
      _sum: { amount: true },
    }),
    prisma.otherIncome.aggregate({
      where: { house_id: houseId, income_date: { gte: startDate, lte: endDate }, deleted_at: null },
      _sum: { amount: true },
    }),
    prisma.unit.findMany({
      where: { house_id: houseId, deleted_at: null },
      include: { leases: { where: { status: 'ACTIVE' } } },
    }),
  ])

  const totalRentCollected = charges.reduce((sum, c) => {
    const paid = c.payments.reduce((s, p) => s.add(new Decimal(p.amount.toString())), new Decimal(0))
    return sum.add(paid)
  }, new Decimal(0))

  const totalOtherIncome = new Decimal(otherIncome._sum.amount?.toString() ?? '0')
  const totalExpenses = new Decimal(expenses._sum.amount?.toString() ?? '0')
  const netIncome = totalRentCollected.add(totalOtherIncome).sub(totalExpenses)
  const overdueAmount = charges
    .filter((c) => c.status === 'OVERDUE')
    .reduce((sum, c) => sum.add(new Decimal(c.amount_due.toString())), new Decimal(0))

  const occupiedUnits = units.filter((u) => u.leases.length > 0).length
  const vacantUnits = units.length - occupiedUnits

  const rentRoll = charges.map((c) => ({
    unit_id: c.unit_id,
    unit_name: c.unit.name,
    tenant_name: c.lease.tenant.full_name,
    amount_due: c.amount_due.toString(),
    amount_paid: c.payments.reduce((s, p) => s.add(new Decimal(p.amount.toString())), new Decimal(0)).toString(),
    status: c.status,
  }))

  const report = {
    house_id: houseId,
    period_type: 'MONTHLY' as const,
    period_key: periodKey,
    total_rent_collected: totalRentCollected,
    total_other_income: totalOtherIncome,
    total_expenses: totalExpenses,
    net_income: netIncome,
    occupied_units: occupiedUnits,
    vacant_units: vacantUnits,
    overdue_amount: overdueAmount,
    rent_roll: rentRoll,
    data: { charges: charges.length },
    is_final: !isCurrentMonth,
  }

  // Cache it for past months
  if (!isCurrentMonth) {
    await prisma.reportSnapshot.upsert({
      where: { house_id_period_type_period_key: { house_id: houseId, period_type: 'MONTHLY', period_key: periodKey } },
      create: report,
      update: { ...report, updated_at: new Date() },
    })
  }

  return report
}

function getMonthBounds(periodKey: string): [Date, Date] {
  const [year, month] = periodKey.split('-').map(Number)
  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0, 23, 59, 59)
  return [start, end]
}
```

---

## 12. API Endpoints Reference

### Authentication
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/signin` | Login (NextAuth) |
| POST | `/api/auth/signout` | Logout |
| GET | `/api/auth/session` | Current session |

### Dashboard
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard?houseId=` | Rent collection %, awaiting/paid this month, expense total, net income — single aggregate call for the dashboard screen |

### Houses
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/houses` | List owner's houses (drives the house switcher dropdown) |
| POST | `/api/v1/houses` | Create house (plan limit enforced) |
| GET | `/api/v1/houses/:id` | House detail |
| PATCH | `/api/v1/houses/:id` | Update house |
| DELETE | `/api/v1/houses/:id` | Soft delete |

### Units
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/houses/:houseId/units` | List units with occupancy + current rent + current tenant |
| POST | `/api/v1/houses/:houseId/units` | Create unit — **also creates the first `RentRate`** from the `monthly_rent` field in one call (see §10a) |
| GET | `/api/v1/houses/:houseId/units/:unitId` | Unit detail |
| GET | `/api/v1/houses/:houseId/units/:unitId/current-tenant` | Derived: who lives here |
| PATCH | `/api/v1/houses/:houseId/units/:unitId` | Update unit. If `monthly_rent` changes, closes old `RentRate` and opens a new one (see rent-rates logic) |
| DELETE | `/api/v1/houses/:houseId/units/:unitId` | Soft delete |

### Tenants
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/tenants?status=active\|former` | All tenants for this landlord, with current unit + lease-end date |
| POST | `/api/v1/tenants` | **Combined onboarding**: creates Tenant + Lease in one transaction from a single form (full_name, national_id, phone, email, photo, unit_id, move_in_date, lease_end) — see §10b |
| GET | `/api/v1/tenants/:id` | Tenant + full lease history + family members + documents |
| PATCH | `/api/v1/tenants/:id` | Update contact info / photo |
| DELETE | `/api/v1/tenants/:id` | Soft delete (blocked if an ACTIVE lease exists — end the lease first) |
| POST | `/api/v1/tenants/:id/family-members` | Add a family member (`name`, `relation`) |
| PATCH | `/api/v1/tenants/:id/family-members/:memberId` | Update a family member |
| DELETE | `/api/v1/tenants/:id/family-members/:memberId` | Remove a family member |
| POST | `/api/v1/tenants/:id/documents/presign` | Get R2 presigned upload URL for NID/passport scan (image or PDF) |
| POST | `/api/v1/tenants/:id/documents/confirm` | Confirm upload, create `Attachment` with `document_type` |
| GET | `/api/v1/tenants/:id/documents` | List a tenant's uploaded documents |
| DELETE | `/api/v1/tenants/:id/documents/:attachmentId` | Soft delete a document |

### Leases
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/leases` | Query leases (`?houseId=&unitId=&status=`) |
| POST | `/api/v1/leases` | Move in (creates lease) |
| GET | `/api/v1/leases/:id` | Lease detail |
| PATCH | `/api/v1/leases/:id/end` | Move out (ends lease) |

### Rent Rates
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/rent-rates?unitId=` | Rate history for a unit |
| POST | `/api/v1/rent-rates` | Set new rate (closes previous) |

### Rent Charges
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/rent-charges` | Query (`?houseId=&unitId=&dueMonth=&status=`) |
| POST | `/api/v1/rent-charges` | Manually create charge |
| GET | `/api/v1/rent-charges/:id` | Charge + payments + balance |
| PATCH | `/api/v1/rent-charges/:id/void` | Void charge |

### Payments
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/payments` | Query payments |
| POST | `/api/v1/payments` | Record payment (idempotent). Accepts either `rent_charge_id` directly, **or** `unit_id + tenant_id + date` — in the latter case the service finds-or-creates the matching month's `RentCharge` first (see §10c). This is what powers the simplified "Add Payment" form (Unit, Tenant, Amount, Date, Status). |
| PATCH | `/api/v1/payments/:id` | Update notes/reference |
| PATCH | `/api/v1/payments/:id/void` | Void payment |
| PATCH | `/api/v1/payments/:id/refund` | Mark refunded |

### Expenses
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/expenses?houseId=&dateFrom=&dateTo=` | Query expenses |
| POST | `/api/v1/expenses` | Create expense |
| PATCH | `/api/v1/expenses/:id` | Update |
| DELETE | `/api/v1/expenses/:id` | Soft delete |

### Other Income
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/other-income?houseId=` | Query |
| POST | `/api/v1/other-income` | Create |
| PATCH | `/api/v1/other-income/:id` | Update |
| DELETE | `/api/v1/other-income/:id` | Soft delete |

### Reports
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/reports/monthly?houseId=&month=2024-03` | Monthly report (cached or live) |
| GET | `/api/v1/reports/yearly?houseId=&year=2024` | Yearly aggregate |

### Attachments
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/attachments/presign` | Get R2 presigned upload URL |
| POST | `/api/v1/attachments/confirm` | Confirm upload, create DB record |
| GET | `/api/v1/attachments?ownerType=&ownerId=` | List attachments |
| DELETE | `/api/v1/attachments/:id` | Soft delete |

### Audit Logs
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/audit-logs?entityType=&entityId=` | Read-only history |

### Subscription
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/subscription` | Current plan + usage |
| POST | `/api/v1/subscription/upgrade` | Upgrade plan |

---

## 13. Business Rules

### Free-tier house limit
```typescript
// Checked in house.service.ts before every create
const activeCount = await prisma.house.count({
  where: { owner_id: userId, deleted_at: null }  // deleted houses do NOT count
})
if (activeCount >= plan.max_houses) throw HOUSE_LIMIT_REACHED
```

### One active lease per unit
```
DB: partial unique index on leases(unit_id) WHERE status = 'ACTIVE'
Service: check no ACTIVE lease exists before creating a new one → 409 UNIT_ALREADY_OCCUPIED
```

### One active rent rate per unit
```
DB: partial unique index on rent_rates(unit_id) WHERE effective_to IS NULL
Service: close previous rate (set effective_to) before inserting new one — in a transaction
```

### Duplicate payment prevention
```
DB: idempotency_key is UNIQUE on payments table
Service: check for existing payment with same key → return 200 with existing record, not 201
```

### Payment voiding — no data loss
```
status = 'VOIDED', void_reason = '...', voided_at = now()
Record is NEVER deleted
Rent charge status recalculated from remaining CONFIRMED payments
If snapshot exists for that period → set is_final = false
```

### Rent change during active tenancy
```
1. Close current rent_rate: SET effective_to = effective_from_new - 1 day
2. Insert new rent_rate: effective_to = null
3. Past rent_charges: amount_due unchanged (snapshot preserved)
4. Next cron run: new charges use the new rate
All in a transaction. Audit logged.
```

### Tenant moves out
```
1. PATCH /leases/:id/end → status = ENDED, move_out_date = X, ended_reason = Y
2. partial unique index released → unit is now vacant
3. All rent_charges and payments for old lease: preserved, untouched
4. New lease can now be created for same unit
```

### Pro-rated rent (mid-month move-in)
```
Service calculates: amount_due = (days_remaining_in_month / days_in_month) × monthly_rate
Stored as normal rent_charge with notes = "Pro-rated: 16/30 days"
No special schema needed
```

### Report after historical edit
```
When payment voided or expense deleted:
  → Set report_snapshot.is_final = false for that period_key
  → Next GET /reports/monthly for that period recomputes live and re-caches
```

---

## 14. Frontend Design System

### Design Tokens

```css
:root {
  /* Brand — slate-blue anchored in property and reliability */
  --color-primary:      #2563eb;
  --color-primary-dark: #1d4ed8;
  --color-primary-50:   #eff6ff;
  --color-primary-100:  #dbeafe;

  /* Surface */
  --color-bg:           #f8fafc;
  --color-surface:      #ffffff;
  --color-border:       #e2e8f0;
  --color-border-strong:#cbd5e1;

  /* Text */
  --color-text:         #0f172a;
  --color-text-muted:   #64748b;
  --color-text-faint:   #94a3b8;

  /* Status */
  --color-success:      #16a34a;
  --color-success-bg:   #f0fdf4;
  --color-warning:      #d97706;
  --color-warning-bg:   #fffbeb;
  --color-danger:       #dc2626;
  --color-danger-bg:    #fef2f2;
  --color-info:         #0284c7;
  --color-info-bg:      #f0f9ff;
  --color-neutral:      #64748b;
  --color-neutral-bg:   #f1f5f9;

  /* Typography */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace; /* all money amounts */

  /* Radius */
  --radius-sm:  4px;
  --radius-md:  8px;
  --radius-lg:  12px;
  --radius-xl:  16px;
  --radius-2xl: 24px;

  /* Shadows */
  --shadow-xs:  0 1px 2px rgba(0,0,0,0.04);
  --shadow-sm:  0 1px 3px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md:  0 4px 6px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04);
  --shadow-lg:  0 10px 15px rgba(0,0,0,0.08), 0 4px 6px rgba(0,0,0,0.04);

  /* Transitions */
  --transition: 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Status Badge Config (TypeScript)

```typescript
export const rentChargeStatusConfig = {
  PAID:    { label: 'Paid',    bg: 'var(--color-success-bg)', color: 'var(--color-success)',  dot: '#16a34a' },
  PARTIAL: { label: 'Partial', bg: '#fff7ed',                 color: '#c2410c',               dot: '#f97316' },
  UNPAID:  { label: 'Unpaid',  bg: 'var(--color-warning-bg)', color: 'var(--color-warning)',  dot: '#d97706' },
  OVERDUE: { label: 'Overdue', bg: 'var(--color-danger-bg)',  color: 'var(--color-danger)',   dot: '#dc2626' },
  VOIDED:  { label: 'Voided',  bg: 'var(--color-neutral-bg)', color: 'var(--color-neutral)',  dot: '#94a3b8' },
} as const

export const leaseStatusConfig = {
  ACTIVE:     { label: 'Active',     bg: 'var(--color-success-bg)', color: 'var(--color-success)' },
  ENDED:      { label: 'Ended',      bg: 'var(--color-neutral-bg)', color: 'var(--color-neutral)' },
  TERMINATED: { label: 'Terminated', bg: 'var(--color-danger-bg)',  color: 'var(--color-danger)'  },
} as const
```

### Responsive Layout

```css
/* App shell — mobile bottom nav, desktop sidebar */
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-content {
  flex: 1;
  padding: 16px;
  padding-bottom: 80px; /* space for mobile bottom nav */
}

@media (min-width: 1024px) {
  .app-shell {
    flex-direction: row;
  }

  .app-sidebar {
    width: 240px;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    border-right: 1px solid var(--color-border);
  }

  .app-content {
    flex: 1;
    padding: 24px 32px;
    padding-bottom: 24px;
    max-width: 1200px;
  }
}

/* Dashboard stat grid */
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (min-width: 768px) {
  .stat-grid { grid-template-columns: repeat(4, 1fr); gap: 16px; }
}

/* Unit cards grid */
.unit-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

@media (min-width: 640px) {
  .unit-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (min-width: 1024px) {
  .unit-grid { grid-template-columns: repeat(3, 1fr); }
}

/* Tables: horizontal scroll on mobile */
.table-wrapper {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
}

.table-wrapper table {
  min-width: 600px;
  width: 100%;
  border-collapse: collapse;
}
```

### Money Rendering Rule

```typescript
// Always render money in monospace font with 2 decimal places
// Never use parseFloat() anywhere in the codebase

export function Money({ amount }: { amount: string | Decimal }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
      {new Decimal(amount.toString()).toFixed(2)}
    </span>
  )
}
```

---

## 15. Environment Variables

```env
# NextAuth
NEXTAUTH_SECRET=minimum-32-character-random-string
NEXTAUTH_URL=https://your-app.vercel.app

# Supabase — use Transaction Pooler for app, Direct for migrations
DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_DATABASE_URL=postgresql://postgres.[ref]:[pass]@aws-0-region.pooler.supabase.com:5432/postgres

# Cloudflare R2
R2_ENDPOINT=https://[account-id].r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret
R2_BUCKET=tenant-attachments
R2_PUBLIC_URL=https://pub-xxx.r2.dev

# Resend (email reminders)
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM=noreply@yourdomain.com

# Cron security — random string, set same value in Vercel dashboard
CRON_SECRET=your-random-cron-secret

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
NODE_ENV=production
```

---

## 16. Free Tier Summary

| Service | Plan | What You Get | Limit Before Paid |
|---|---|---|---|
| **Vercel** | Hobby (free) | Unlimited deploys, 100GB bandwidth, **2 cron jobs** | Need more crons → $20/mo Pro |
| **Supabase** | Free | 500MB DB, 2GB bandwidth, 50k MAU | 500MB DB → $25/mo Pro |
| **Cloudflare R2** | Free | 10GB storage, 0 egress fees | 10GB → $0.015/GB after |
| **Resend** | Free | 3,000 emails/month, 100/day | 3k/mo → $20/mo |
| **Total** | **$0/month** | — | ~50–100 active landlords |

---

## 17. Setup Commands

```bash
# 1. Bootstrap
npx create-next-app@latest tenant-saas --typescript --tailwind --app --src-dir

# 2. Dependencies
npm install prisma @prisma/client
npm install next-auth @auth/prisma-adapter
npm install zod decimal.js date-fns
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
npm install resend

# 3. Dev dependencies
npm install -D @types/node

# 4. Prisma
npx prisma init
# → paste schema into prisma/schema.prisma
npx prisma migrate dev --name init
# → add partial indexes via raw SQL in the migration file
npx prisma generate

# 5. Run locally
npm run dev

# 6. Deploy
vercel --prod
```

---

## 18. Implementation Order

```
Week 1  Auth (NextAuth) + Users + Subscription check
Week 2  Houses + Units (CRUD + soft delete + plan limit)
Week 3  Tenants + Leases (move-in, move-out, occupancy queries)
Week 4  Rent Rates + Rent Charges (generation + void)
Week 5  Payments (idempotency + void + refund + charge status recompute)
Week 6  Expenses + Other Income + Attachments (R2 presign flow)
Week 7  Reports (lazy compute + snapshot cache + stale invalidation)
Week 8  Cron jobs (generate charges + overdue detection + reminders)
Week 9  Dashboard UI + unit cards + payment tables + responsive polish
Week 10 Audit log viewer + settings + subscription upgrade page
```

---

*All domain rules preserved. No Redis. No BullMQ. No contradictions with Vercel's actual capabilities. Two crons only. Tenant scoped to owner, house isolation through leases. Financial records append-only throughout.*
