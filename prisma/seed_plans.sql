-- =============================================================================
-- Plan seed for Supabase
-- =============================================================================
-- Mirrors the rows that `prisma/seed.ts` inserts locally. Paste this into the
-- Supabase SQL Editor → New query → Run. It is safe to re-run: the
-- ON CONFLICT clause updates any existing rows to the canonical values, so
-- drift between this file and seed.ts is corrected on each run.
--
-- Use this whenever the register endpoint fails with:
--   "FREE plan is missing. Run `npm run db:seed` before registering users."
--
-- IMPORTANT: keep the JSONB `features` shape in sync with prisma/seed.ts.
--
-- F3 targets: FREE = 1 house / 3 units per house / 3 tenants / 30-day trial.
-- PRO uses the Int32.MAX sentinel (2147483647) for every cap.

INSERT INTO "public"."Plan" (
  "id", "name", "max_houses", "max_units_per_house", "max_tenants",
  "trial_days", "price_monthly", "features", "is_active",
  "created_at", "updated_at"
) VALUES
  (
    'plan_free_seed_0000000000000',
    'FREE',
    1,
    3,
    3,
    30,
    0,
    '{"max_houses": 1, "max_units_per_house": 3, "max_tenants": 3, "trial_days": 30, "reports": false, "attachments": true}'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'plan_pro_seed_00000000000000',
    'PRO',
    2147483647,
    2147483647,
    2147483647,
    30,
    29.00,
    '{"max_houses": "unlimited", "max_units_per_house": "unlimited", "max_tenants": "unlimited", "trial_days": 30, "reports": true, "attachments": true}'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("name") DO UPDATE SET
  "max_houses"          = EXCLUDED."max_houses",
  "max_units_per_house" = EXCLUDED."max_units_per_house",
  "max_tenants"         = EXCLUDED."max_tenants",
  "trial_days"          = EXCLUDED."trial_days",
  "price_monthly"       = EXCLUDED."price_monthly",
  "features"            = EXCLUDED."features",
  "is_active"           = EXCLUDED."is_active",
  "updated_at"          = CURRENT_TIMESTAMP;
