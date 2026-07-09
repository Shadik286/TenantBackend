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