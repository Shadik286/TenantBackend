// What we read out of a bdApps subscription payload.
//
//   npx tsx scripts/verify-bdapps-classify.ts
//
// There is no test runner in this repo, so this is a script: it asserts the
// cases that actually bite, prints them, and exits non-zero on the first
// disagreement. Every payload below is either one captured from the gateway
// or one the reference web client (BkashBddapps/index.html) handles
// explicitly.
import assert from "node:assert/strict";

import { classify } from "@/lib/bdapps";

const cases: Array<{
  name: string;
  payload: Record<string, unknown>;
  expect: "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN";
}> = [
  {
    name: "bridge says subscribed",
    payload: { isSubscribed: true, subscriptionStatus: "REGISTERED", statusCode: "S1000" },
    expect: "REGISTERED",
  },
  {
    name: "explicit UNREGISTERED under a success code",
    payload: { isSubscribed: false, subscriptionStatus: "UNREGISTERED", statusCode: "S1000" },
    expect: "NOT_REGISTERED",
  },
  {
    // The case this change exists for: bdApps reports this while a first
    // charge settles, right after the payment gateway hands the user back.
    name: "first charge still settling",
    payload: {
      isSubscribed: false,
      subscriptionStatus: "INITIAL CHARGING PENDING",
      statusCode: "S1000",
    },
    expect: "REGISTERED",
  },
  {
    name: "success code with nothing in it tells us nothing",
    payload: { isSubscribed: false, subscriptionStatus: "", statusCode: "S1000" },
    expect: "UNKNOWN",
  },
  {
    // Captured live from our own bridge on 2026-09-17 (01700000000):
    //   {"subscriptionStatus":"","isSubscribed":false,"apiError":true,
    //    "statusCode":"E1951",
    //    "statusDetail":"Format of the address is invalid Or User Already
    //    UnRegistered", ...}
    // This is how SDKRenten says "no", so it has to stay a definite no -
    // otherwise nothing can ever downgrade a lapsed account.
    name: "E1951 invalid address or already unregistered",
    payload: {
      subscriptionStatus: "",
      isSubscribed: false,
      apiError: true,
      statusCode: "E1951",
      statusDetail:
        "Format of the address is invalid Or User Already UnRegistered",
    },
    expect: "NOT_REGISTERED",
  },
  {
    // The older capture, same meaning.
    name: "E1325 invalid address format",
    payload: {
      isSubscribed: false,
      subscriptionStatus: "",
      statusCode: "E1325",
      statusDetail: "Format of the address is invalid.",
    },
    expect: "NOT_REGISTERED",
  },
  {
    // A fact about our provisioning, not about the subscriber - a bKash
    // subscriber on an unsupported operator answers this way while paying.
    name: "E1343 operator not provisioned for this application",
    payload: { statusCode: "E1343", statusDetail: "non white listed operator" },
    expect: "UNKNOWN",
  },
  {
    name: "E1301 operator unknown",
    payload: { statusCode: "E1301", statusDetail: "Operator unknown" },
    expect: "UNKNOWN",
  },
  {
    name: "send_otp refusing: already registered",
    payload: { statusCode: "E1351", message: "User already registered" },
    expect: "REGISTERED",
  },
  {
    name: "already registered, said in prose only",
    payload: { message: "This number is already registered." },
    expect: "REGISTERED",
  },
  {
    name: "an empty body is not a no",
    payload: {},
    expect: "UNKNOWN",
  },
  {
    name: "a bare REGISTERED, with no status code alongside it",
    payload: { subscriptionStatus: "REGISTERED" },
    expect: "REGISTERED",
  },
];

let failed = 0;
for (const testCase of cases) {
  const actual = classify(testCase.payload);
  try {
    assert.equal(actual, testCase.expect);
    console.log(`  ok    ${testCase.name} -> ${actual}`);
  } catch {
    failed += 1;
    console.error(
      `  FAIL  ${testCase.name}: expected ${testCase.expect}, got ${actual}`,
    );
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
