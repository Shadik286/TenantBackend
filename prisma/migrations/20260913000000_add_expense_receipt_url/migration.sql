-- Receipt photo for an expense.
--
-- Additive and nullable, so the currently-deployed application (which does not
-- know the column exists) keeps working unchanged against a migrated database.
-- No backfill: pre-existing expenses simply have no receipt.

ALTER TABLE "public"."Expense" ADD COLUMN "receipt_url" TEXT;
