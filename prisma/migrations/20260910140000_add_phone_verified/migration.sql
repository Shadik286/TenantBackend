-- F2 — track whether a phone number's ownership was actually proven.
--
-- Defaults to false, then backfills bdapps accounts to true: those numbers went
-- through the carrier gateway's OTP before our backend ever saw them, so they
-- are the only ones currently trustworthy.
--
-- Google and local accounts stay false. No OTP flow exists for them yet; the
-- unique constraint on `phone` is what stops one user claiming another's
-- number, and this flag is what F4 will consult before letting an unverified
-- number claim a paid subscription.

ALTER TABLE "public"."User" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;

UPDATE "public"."User"
   SET "phone_verified" = true
 WHERE "provider" = 'bdapps' AND "phone" IS NOT NULL;
