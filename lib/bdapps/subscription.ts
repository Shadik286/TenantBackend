// bdApps subscription authorization.
//
// The flow is a browser redirect, not an API call:
//
//   1. We build a signed URL to https://user.bdapps.com/sdk/subscription/authorize
//   2. The user opens it, confirms with their operator, and is sent back to
//      our `redirectUrl`
//   3. We read the result off that return and activate PRO
//
// The signing scheme matches bdApps' own reference implementation — see
// `signAuthorizeRequest` for the exact input and the parts that are easy to
// get wrong. The parameters go on the query string in the order bdApps
// documents: apiKey, requestId, requestTime, signature, redirectUrl.
import { createHash } from "crypto";

const AUTHORIZE_ENDPOINT =
  "https://user.bdapps.com/sdk/subscription/authorize";

export type BdappsCredentials = { apiKey: string; apiSecret: string };

/**
 * Read the gateway credentials.
 *
 * The Vercel variables are named `Bkash_API_Key` / `Bkash_API_Secret` — mixed
 * case, and `process.env` is case-sensitive, so those exact spellings have to
 * be read. The uppercase forms are accepted too so the names can be tidied
 * later without breaking a running deployment.
 */
export function bdappsCredentials(): BdappsCredentials | null {
  const apiKey =
    process.env.Bkash_API_Key ??
    process.env.BKASH_API_KEY ??
    process.env.BDAPPS_API_KEY;
  const apiSecret =
    process.env.Bkash_API_Secret ??
    process.env.BKASH_API_SECRET ??
    process.env.BDAPPS_API_SECRET;

  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

/**
 * `requestId` — unique per attempt.
 *
 * Shaped like the sample bdApps gave (`260902154812345`): a yyMMddHHmmss
 * stamp plus three random digits. The randomness matters because two users
 * starting a subscription in the same second would otherwise collide, and
 * `request_id` is a unique column.
 */
export function makeRequestId(now: Date = new Date()): string {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  const stamp =
    p(now.getUTCFullYear() % 100) +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCDate()) +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds());
  // 100–999, matching bdApps' reference. Deliberately not 0–999: their
  // generator never emits a leading-zero triple, and the format is specified
  // as "exactly 15 digits" (12 of stamp + 3 of randomness).
  const rand = Math.floor(100 + Math.random() * 900);
  return `${stamp}${rand}`;
}

/** ISO-8601 with milliseconds, e.g. `2026-09-02T09:48:12.123Z`. */
export function makeRequestTime(now: Date = new Date()): string {
  return now.toISOString();
}

type SignatureInput = {
  apiKey: string;
  apiSecret: string;
  requestTime: string;
};

/**
 * The SHA-512 signature, per bdApps' reference implementation:
 *
 *   sha512( apiKey + "|" + requestTime + "|" + apiSecret )   → lowercase hex
 *
 * Three details that are easy to get wrong, and that I did get wrong before
 * the reference arrived:
 *
 *   * The fields are PIPE-DELIMITED, not concatenated. Without the
 *     separators the digest is over a different string entirely.
 *   * `requestId` is NOT part of the signature, even though it is sent as a
 *     query parameter. Only apiKey, requestTime and the secret are signed.
 *   * The hex digest is LOWERCASE. `crypto.subtle` + `toString(16)` in their
 *     JS produces lowercase, so upper-casing it breaks the comparison.
 */
export function signAuthorizeRequest(input: SignatureInput): string {
  const payload = `${input.apiKey}|${input.requestTime}|${input.apiSecret}`;
  return createHash("sha512").update(payload, "utf8").digest("hex");
}

export type AuthorizeUrl = {
  url: string;
  requestId: string;
  requestTime: string;
};

/**
 * Build the URL the user opens to authorize a subscription.
 *
 * Every value is URL-encoded by `URLSearchParams`, including `redirectUrl`,
 * which must arrive percent-encoded — the sample bdApps supplied shows
 * `https%3A%2F%2F...`.
 */
/**
 * The identity of one attempt, made before the URL is built.
 *
 * Split out because the requestId has to go INTO `redirectUrl` - bdApps
 * returns the user with an empty query string, so the only way to know who
 * came back is to have put it in the path we handed them.
 */
export type PendingAuthorize = { requestId: string; requestTime: string };

export function makeAuthorizeRequest(now: Date = new Date()): PendingAuthorize {
  return { requestId: makeRequestId(now), requestTime: makeRequestTime(now) };
}

export function buildAuthorizeUrl(
  credentials: BdappsCredentials,
  redirectUrl: string,
  pending: PendingAuthorize = makeAuthorizeRequest(),
): AuthorizeUrl {
  const { requestId, requestTime } = pending;

  const signature = signAuthorizeRequest({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    requestTime,
  });

  const params = new URLSearchParams({
    apiKey: credentials.apiKey,
    requestId,
    requestTime,
    signature,
    redirectUrl,
  });

  return {
    url: `${AUTHORIZE_ENDPOINT}?${params.toString()}`,
    requestId,
    requestTime,
  };
}

/**
 * Did the gateway's return explicitly say the subscription FAILED?
 *
 * Note the inversion. The first version of this asked "did it say success?"
 * and treated anything else as failure — which rejected every real payment,
 * because bdApps does not send a success parameter at all.
 *
 * `BkashBddapps/subscription-return.html` is explicit about this:
 *
 *   "bdapps does not document the parameters it appends to redirectUrl, so
 *    record whatever arrives here to pin down the real contract"
 *
 * and it treats arrival at the return URL as the completion signal. So: only
 * an explicit failure marker counts as failure here. Arrival alone is not
 * taken as proof of payment either — the caller confirms with bdApps before
 * granting anything (see app/api/subscription/return).
 */
export function isExplicitFailureReturn(params: URLSearchParams): boolean {
  const failing = new Set([
    "failed",
    "failure",
    "false",
    "0",
    "cancelled",
    "canceled",
    "declined",
    "rejected",
    "error",
  ]);

  for (const key of ["status", "statusCode", "resultCode", "result", "state"]) {
    const value = params.get(key);
    if (value && failing.has(value.trim().toLowerCase())) return true;
  }

  // bdApps' own SDK error codes (E1001–E1012) on the return mean the flow
  // did not complete.
  for (const key of ["StatusCode", "errorCode", "error_code"]) {
    const value = params.get(key);
    if (value && /^E\d{4}$/i.test(value.trim())) return true;
  }

  return false;
}

/**
 * Pull a subscriber MSISDN off the return, if bdApps put one there.
 *
 * Mirrors `returnedPhone()` in their reference page, which probes several
 * spellings for the same reason: the contract is undocumented, so the field
 * name is a guess and the value's shape is the only reliable test.
 */
export function subscriberPhoneFromReturn(
  params: URLSearchParams,
): string | null {
  for (const key of [
    "subscriberId",
    "subscriber_id",
    "msisdn",
    "mobile",
    "user_mobile",
    "phone",
  ]) {
    const digits = (params.get(key) ?? "").replace(/\D+/g, "");
    if (/^8801[3-9]\d{8}$/.test(digits)) return digits.slice(2);
    if (/^01[3-9]\d{8}$/.test(digits)) return digits;
    if (/^[1-9]\d{5,14}$/.test(digits)) return digits;
  }
  return null;
}
