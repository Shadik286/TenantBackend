-- Where a BdappsSubscriptionEvent came from.
--
-- getStatus answers E1951 for every number on the bKash application, including
-- a paying one, so it cannot confirm a subscription. The OTP request can: it
-- refuses a subscriber with E1351 "user already registered". But it also texts
-- an OTP to anyone who is NOT subscribed, so its verdicts are recorded and
-- reused for a few minutes rather than asked again on every poll.

ALTER TABLE "BdappsSubscriptionEvent"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'notification';

CREATE INDEX "BdappsSubscriptionEvent_phone_source_received_at_idx"
    ON "BdappsSubscriptionEvent"("phone", "source", "received_at");
