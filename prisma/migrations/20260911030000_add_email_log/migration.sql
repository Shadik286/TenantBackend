-- F8 — outbound notification log.
--
-- `dedupe_key` carries the UNIQUE constraint that makes double-sending
-- impossible. It identifies the underlying EVENT (this payment, this lease),
-- not the send attempt, so a retried request collides with the original row
-- instead of mailing the tenant a second invoice.
--
-- This matters specifically because POST /api/payments is idempotent: when an
-- idempotency key repeats it returns the EXISTING payment. Without a dedupe
-- key, that replay path looks identical to a fresh payment and the tenant gets
-- billed twice by email.
--
-- `channel` defaults to EMAIL but exists from day one: in Bangladesh SMS and
-- WhatsApp reach tenants far more reliably than email, and `Tenant.email` is
-- nullable precisely because the address is often missing.

CREATE TABLE "public"."EmailLog" (
    "id"          TEXT NOT NULL,
    "user_id"     TEXT,
    "tenant_id"   TEXT,
    "kind"        TEXT NOT NULL,
    "channel"     TEXT NOT NULL DEFAULT 'EMAIL',
    "to_address"  TEXT NOT NULL,
    "subject"     TEXT,
    "dedupe_key"  TEXT NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'PENDING',
    "provider_id" TEXT,
    "error"       TEXT,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"     TIMESTAMP(3),

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- The idempotency guarantee.
CREATE UNIQUE INDEX "EmailLog_dedupe_key_key" ON "public"."EmailLog"("dedupe_key");

-- "What did we send this tenant?" — the support question this table answers.
CREATE INDEX "EmailLog_tenant_id_created_at_idx" ON "public"."EmailLog"("tenant_id", "created_at");

-- Finding FAILED rows to retry.
CREATE INDEX "EmailLog_status_created_at_idx" ON "public"."EmailLog"("status", "created_at");

-- ON DELETE SET NULL, not CASCADE: a deleted tenant must not erase the record
-- that we mailed them. The log is evidence, and losing it on tenant cleanup
-- would defeat the audit purpose.
ALTER TABLE "public"."EmailLog"
  ADD CONSTRAINT "EmailLog_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."Tenant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
