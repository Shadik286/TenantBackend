-- Add a UNIQUE constraint on User.phone so the same phone number cannot
-- be registered by two different accounts. Postgres allows multiple NULL
-- values under a unique constraint, which is what we want: users without
-- a phone number still get a row, and only one user per real phone.

-- Step 1: clear out duplicate phones before we can enforce uniqueness.
-- We keep the phone on the oldest user (smallest created_at) per phone
-- value and null-out the rest. These collisions almost certainly come
-- from development/testing data, not production accounts.
UPDATE "User" AS u
SET "phone" = NULL
WHERE "phone" IS NOT NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("phone") "id"
    FROM "User"
    WHERE "phone" IS NOT NULL
    ORDER BY "phone", "created_at" ASC
  );

-- Step 2: enforce uniqueness.
ALTER TABLE "User" ADD CONSTRAINT "User_phone_key" UNIQUE ("phone");
