-- Adds the per-plan "max_units_per_house" column.
-- FREE plans default to 5 units/house; PRO plans are bumped to the
-- Int.MAX sentinel (2_147_483_647) so service code can treat it as
-- "unlimited" without a separate boolean column.

ALTER TABLE "Plan"
  ADD COLUMN "max_units_per_house" INTEGER NOT NULL DEFAULT 5;

UPDATE "Plan"
  SET "max_units_per_house" = 2147483647
  WHERE "name" = 'PRO';
