-- Backfill a placeholder RentRate row for every active Unit that does
-- not currently have an open rate (`effective_to IS NULL`). Without an
-- open row the Flutter unit-details modal renders the rent as `৳0.00`
-- even when the owner previously set a value on the unit.
--
-- Idempotent: the WHERE clause skips any unit that already has an open
-- rate. Amount is `0`; the owner can edit the unit to set the real
-- value, which closes this placeholder and opens a new row.
INSERT INTO "RentRate" (
  "id",
  "unit_id",
  "amount",
  "effective_from",
  "effective_to",
  "set_by",
  "notes",
  "created_at"
)
SELECT
  gen_random_uuid()::text,
  u."id",
  0,
  COALESCE(u."created_at", NOW()),
  NULL,
  h."owner_id",
  'Backfilled placeholder — edit the unit to set the real rent.',
  NOW()
FROM "Unit" u
JOIN "House" h ON h."id" = u."house_id"
WHERE u."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "RentRate" rr
    WHERE rr."unit_id" = u."id"
      AND rr."effective_to" IS NULL
  );
