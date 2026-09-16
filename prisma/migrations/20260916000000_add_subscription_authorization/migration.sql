-- F6: bdApps subscription authorization.
--
-- The gateway redirects the user to user.bdapps.com and bounces them back to
-- our redirectUrl. That return carries a requestId and no proof of identity —
-- a session cookie does not reliably survive a round trip through an external
-- site on mobile. So the requestId -> user mapping is written down before the
-- user leaves, and read back when they return.

CREATE TYPE "SubscriptionAuthStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

CREATE TABLE "SubscriptionAuthorization" (
    "id"             TEXT NOT NULL,
    "user_id"        TEXT NOT NULL,
    "request_id"     TEXT NOT NULL,
    "request_time"   TEXT NOT NULL,
    "status"         "SubscriptionAuthStatus" NOT NULL DEFAULT 'PENDING',
    "plan_name"      TEXT NOT NULL DEFAULT 'PRO',
    "return_payload" JSONB,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"   TIMESTAMP(3),

    CONSTRAINT "SubscriptionAuthorization_pkey" PRIMARY KEY ("id")
);

-- Unique, and that is what makes the return idempotent: a refreshed return
-- page or a retrying gateway cannot grant a second subscription period.
CREATE UNIQUE INDEX "SubscriptionAuthorization_request_id_key"
    ON "SubscriptionAuthorization"("request_id");

CREATE INDEX "SubscriptionAuthorization_user_id_status_idx"
    ON "SubscriptionAuthorization"("user_id", "status");

ALTER TABLE "SubscriptionAuthorization"
    ADD CONSTRAINT "SubscriptionAuthorization_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
