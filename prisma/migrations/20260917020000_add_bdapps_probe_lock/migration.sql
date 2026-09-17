-- One OTP probe at a time per number.
--
-- The OTP request texts a non-subscriber an OTP. After a payment several
-- requests arrive within the same second (return URL, poll, resume handler),
-- none had a recorded verdict yet, and each asked - two texts for one
-- cancelled payment. A probe now holds this row while it runs.

CREATE TABLE "BdappsProbeLock" (
    "phone"        TEXT NOT NULL,
    "locked_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BdappsProbeLock_pkey" PRIMARY KEY ("phone")
);
