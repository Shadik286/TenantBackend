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
import { classifyOtpProbe } from "@/lib/bdapps/otp-probe";

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
    // Measured across both applications on 2026-09-17: /SDKRent%26Tenand/
    // answers S1000 for the one number it knows and E1325 for every other,
    // while /SDKRenten/ answers E1951 for all of them. An E-code is therefore
    // "this application has never heard of this number" - the normal state of
    // a bKash subscriber, whose billing getStatus cannot see - and must not
    // read as a denial, or a paying bKash customer looks cancelled.
    name: "E1951 subscriber unknown to this application",
    payload: {
      subscriptionStatus: "",
      isSubscribed: false,
      apiError: true,
      statusCode: "E1951",
      statusDetail:
        "Format of the address is invalid Or User Already UnRegistered",
    },
    expect: "UNKNOWN",
  },
  {
    // Same meaning from the other application.
    name: "E1325 subscriber unknown to this application",
    payload: {
      isSubscribed: false,
      subscriptionStatus: "",
      statusCode: "E1325",
      statusDetail: "Format of the address is invalid.",
    },
    expect: "UNKNOWN",
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

// The OTP request, used where getStatus cannot answer (the bKash application
// answers E1951 to getStatus for everyone, subscribed or not).
const otpCases: typeof cases = [
  {
    // Captured live on 2026-09-17 from SDKRenten/send_otp.php for a number
    // bdApps holds as subscribed - the answer getStatus could never give.
    name: "OTP request refused: user already registered",
    payload: {
      success: false,
      message: "user already registered",
      referenceNo: null,
      statusCode: "E1351",
      statusDetail: "user already registered",
      version: "1.0",
      subscriberId: "tel:8801817932639",
    },
    expect: "REGISTERED",
  },
  {
    // bdApps started a subscription (and texted an OTP): there was none.
    name: "OTP issued means not subscribed",
    payload: {
      success: true,
      referenceNo: "213561321321613",
      statusCode: "S1000",
      statusDetail: "Success",
      version: "1.0",
    },
    expect: "NOT_REGISTERED",
  },
  {
    name: "OTP refused for an unprovisioned operator says nothing",
    payload: {
      success: false,
      statusCode: "E1343",
      statusDetail: "non white listed operator",
    },
    expect: "UNKNOWN",
  },
  {
    name: "OTP request with no usable body says nothing",
    payload: { success: false, referenceNo: null },
    expect: "UNKNOWN",
  },
];

let failed = 0;
for (const testCase of otpCases) {
  const actual = classifyOtpProbe(testCase.payload);
  try {
    assert.equal(actual, testCase.expect);
    console.log(`  ok    [otp] ${testCase.name} -> ${actual}`);
  } catch {
    failed += 1;
    console.error(
      `  FAIL  [otp] ${testCase.name}: expected ${testCase.expect}, got ${actual}`,
    );
  }
}

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

const total = cases.length + otpCases.length;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
