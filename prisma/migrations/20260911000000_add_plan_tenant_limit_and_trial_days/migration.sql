-- F3 free-tier limits.
--
-- Two new caps on Plan:
--   max_tenants -- active tenants across ALL of an owner's houses. Until now
--                  POST /api/tenants enforced nothing at all.
--   trial_days  -- the trial window was a hard-coded 14 in two separate auth
--                  routes; making it a column means changing it is a data
--                  change rather than a deploy.
ALTER TABLE "Plan" ADD COLUMN "max_tenants" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Plan" ADD COLUMN "trial_days"  INTEGER NOT NULL DEFAULT 30;

-- Column defaults only apply to rows inserted from here on, so the existing
-- tiers have to be re-pointed explicitly. FREE also tightens from 2 houses /
-- 5 units to the F3 target of 1 house / 3 units.
--
-- Owners already over the new caps keep every row they have: the limits are
-- checked on create, never enforced retroactively, so this narrows what they
-- can add next without touching what they already built.
--
-- `features` is merged rather than replaced so any key not named here
-- survives. `updated_at` is set by hand because @updatedAt is applied by the
-- Prisma client, which is not in the loop for a raw migration.
UPDATE "Plan"
SET "max_houses"          = 1,
    "max_units_per_house" = 3,
    "max_tenants"         = 3,
    "trial_days"          = 30,
    "features"            = "features" || '{"max_houses":1,"max_units_per_house":3,"max_tenants":3,"trial_days":30}'::jsonb,
    "updated_at"          = CURRENT_TIMESTAMP
WHERE "name" = 'FREE';

-- PRO keeps the Int32.MAX sentinel convention the other two caps already use.
UPDATE "Plan"
SET "max_tenants" = 2147483647,
    "trial_days"  = 30,
    "features"    = "features" || '{"max_tenants":"unlimited"}'::jsonb,
    "updated_at"  = CURRENT_TIMESTAMP
WHERE "name" = 'PRO';
