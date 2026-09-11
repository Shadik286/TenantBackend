-- F5: PIN unlock + persistent, revocable sessions.
--
-- Access JWTs drop from 30 days to 1 hour. That is only safe if a device can
-- get a new one without a full re-login, hence RefreshToken; and the shortened
-- window is only worth having if we can also kill tokens early, hence
-- User.token_version.

ALTER TABLE "User" ADD COLUMN "pin_hash"      TEXT;
ALTER TABLE "User" ADD COLUMN "pin_set_at"    TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

-- Only the SHA-256 hash of a refresh token is stored, so this table is not
-- replayable if it leaks. `token_hash` is UNIQUE both to enforce that and to
-- make the lookup on every refresh an index hit.
CREATE TABLE "RefreshToken" (
    "id"           TEXT NOT NULL,
    "user_id"      TEXT NOT NULL,
    "token_hash"   TEXT NOT NULL,
    "device_label" TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "expires_at"   TIMESTAMP(3) NOT NULL,
    "revoked_at"   TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshToken_token_hash_key" ON "RefreshToken"("token_hash");

-- Serves the "all live sessions for this user" lookup used by revoke-all and
-- by replay detection.
CREATE INDEX "RefreshToken_user_id_revoked_at_idx" ON "RefreshToken"("user_id", "revoked_at");

-- ON DELETE CASCADE: deleting a user must not strand credentials that still
-- resolve to their id.
ALTER TABLE "RefreshToken"
    ADD CONSTRAINT "RefreshToken_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
