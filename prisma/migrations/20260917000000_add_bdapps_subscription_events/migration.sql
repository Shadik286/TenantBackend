-- What bdApps told us, unprompted, about a subscription.
--
-- bdApps cannot be asked about a bKash subscription: getStatus answers only
-- for carrier billing, and the bridge's subscriber list is a local file with
-- no verification. Their subscription notification is the only signal that
-- originates with them, so it is recorded here rather than inferred.

CREATE TABLE "BdappsSubscriptionEvent" (
    "id"             TEXT NOT NULL,
    "subscriber_id"  TEXT NOT NULL,
    "phone"          TEXT,
    "status"         TEXT NOT NULL,
    "application_id" TEXT,
    "time_stamp"     TEXT,
    "received_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BdappsSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- "the latest word on this number" is the only query this table serves.
CREATE INDEX "BdappsSubscriptionEvent_phone_received_at_idx"
    ON "BdappsSubscriptionEvent"("phone", "received_at");

CREATE INDEX "BdappsSubscriptionEvent_subscriber_id_idx"
    ON "BdappsSubscriptionEvent"("subscriber_id");
