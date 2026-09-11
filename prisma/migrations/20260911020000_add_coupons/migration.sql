-- F7: redeemable coupons.

CREATE TYPE "CouponType" AS ENUM ('TRIAL_EXTENSION', 'FREE_PRO');

CREATE TABLE "Coupon" (
    "id"               TEXT NOT NULL,
    "code"             TEXT NOT NULL,
    "type"             "CouponType" NOT NULL,
    "value_days"       INTEGER NOT NULL,
    -- NULL means unlimited.
    "max_redemptions"  INTEGER,
    "redemptions_used" INTEGER NOT NULL DEFAULT 0,
    "valid_from"       TIMESTAMP(3),
    "valid_until"      TIMESTAMP(3),
    "is_active"        BOOLEAN NOT NULL DEFAULT true,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");
CREATE INDEX "Coupon_code_is_active_idx" ON "Coupon"("code", "is_active");

CREATE TABLE "CouponRedemption" (
    "id"          TEXT NOT NULL,
    "coupon_id"   TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- The one-per-user rule. A composite unique rather than a check-then-insert,
-- because two concurrent redemptions would both pass the check.
CREATE UNIQUE INDEX "CouponRedemption_coupon_id_user_id_key"
    ON "CouponRedemption"("coupon_id", "user_id");

-- Serves the "does this user have a live grant" lookup on every plan
-- resolution.
CREATE INDEX "CouponRedemption_user_id_expires_at_idx"
    ON "CouponRedemption"("user_id", "expires_at");

ALTER TABLE "CouponRedemption"
    ADD CONSTRAINT "CouponRedemption_coupon_id_fkey"
    FOREIGN KEY ("coupon_id") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CouponRedemption"
    ADD CONSTRAINT "CouponRedemption_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
