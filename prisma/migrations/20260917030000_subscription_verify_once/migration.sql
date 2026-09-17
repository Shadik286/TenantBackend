-- One bdApps check per payment attempt.
--
-- Every trip through the payment gateway is checked by asking bdApps through
-- the OTP request, exactly once, when the user comes back. These columns make
-- "exactly once" a property of the row: the ask is claimed by a conditional
-- update on verify_started_at, and its answer is kept on the attempt.

ALTER TABLE "SubscriptionAuthorization"
    ADD COLUMN "verify_started_at" TIMESTAMP(3),
    ADD COLUMN "otp_result" TEXT;
