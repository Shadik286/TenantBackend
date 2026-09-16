/**
 * Server-side bdapps gateway client.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/auth/bdapps/login` historically minted a 30-day session from a bare
 * phone number: no password, no OTP check, no signature. The shipped Flutter
 * client does talk to the gateway (`check_subscription.php`, `send_otp.php`)
 * but the backend never saw any of it, so anyone could `curl` the endpoint with
 * someone else's number and receive their session. See SEC-001.
 *
 * The gateway's `check_subscription.php` takes only `user_mobile`, so the
 * BACKEND can call it too. That is what this module does: before minting a
 * session we independently confirm the number is a real, billed subscriber,
 * instead of taking the client's word for it.
 *
 * WHAT THIS DOES AND DOES NOT FIX
 * -------------------------------
 * Fixes: mass account creation, and sessions for numbers that never subscribed.
 * Does NOT fix: an attacker who knows a *subscribed* number can still pass this
 * check, because the gateway only answers "is this number a subscriber?" — it
 * proves nothing about who is asking. Closing that needs either a gateway API
 * that returns something unforgeable (see Q2), or per-request OTP verification.
 * Combined with the `provider` scoping in F1.2 the blast radius is at least
 * limited to bdapps accounts; Google and email/password users are unreachable.
 */

/**
 * Base URL of the PHP bridge that fronts bdApps (the scripts in
 * `BkashBddapps/`: check_subscription.php, send_otp.php, verify_otp.php,
 * unsubscribe.php).
 *
 * `/SDKRent%26Tenand/` also answers on that host and returns byte-identical
 * JSON, but it is an older copy of the same scripts. `/SDKRenten/` is the
 * canonical path, and pointing at the stale one would mean quietly running
 * against code nobody is updating.
 *
 * Overridable by env so a move does not need a redeploy — this is a
 * third-party host we do not control.
 */
export const BDAPPS_BASE = resolveBdappsBase();

/**
 * Every bridge whose `check_subscription.php` should be asked about a number.
 *
 * bdApps subscriptions belong to an APPLICATION, and getStatus only answers
 * for the application whose id and password the bridge was configured with.
 * The reference web client makes this explicit: it keeps two bases and asks
 * both, because "KhelarScore carries mobile balance, SportsNWS24 carries
 * bKash" - a bKash subscriber is invisible to the carrier application's
 * lookup and vice versa.
 *
 * So if bKash payments for this app run through a second bdApps application,
 * point `BDAPPS_BKASH_BASE` at its bridge and both get asked. With it unset
 * this is just [BDAPPS_BASE] and nothing changes.
 */
export function bdappsStatusBases(): string[] {
  // Measured, not assumed: `/SDKRenten/` answers E1951 for a number that
  // `/SDKRent%26Tenand/` answers S1000 UNREGISTERED for. Two different codes
  // for the same MSISDN means two different bdApps applications behind them,
  // not the "older copy of the same scripts" the comments used to claim. The
  // reference client keeps two bases for exactly this reason and asks both.
  const extra = (
    process.env.BDAPPS_BKASH_BASE ??
    process.env.Bdapps_Bkash_Base_URL ??
    "https://androidcontentapp.xyz/SDKRent%26Tenand/"
  ).trim();
  if (!extra) return [BDAPPS_BASE];
  const normalised = extra.replace(/\/+$/, "") + "/";
  return normalised === BDAPPS_BASE ? [BDAPPS_BASE] : [BDAPPS_BASE, normalised];
}

function resolveBdappsBase(): string {
  // `Bdapps_Base_URL` is the spelling used in Vercel. `process.env` is
  // case-sensitive, so the exact casing has to be read; the uppercase forms
  // are accepted too so the name can be tidied later without breaking a
  // running deployment.
  const raw =
    process.env.Bdapps_Base_URL ??
    process.env.BDAPPS_BASE_URL ??
    process.env.BDAPPS_BRIDGE_BASE ??
    "https://androidcontentapp.xyz/SDKRenten/";

  // Collapse any trailing slashes to exactly one. The value in Vercel ends
  // with `//`, which would build `SDKRenten//check_subscription.php` — that
  // happens to work on this host, but it is luck rather than design and a
  // stricter server would 404 on it.
  return raw.replace(/\/+$/, "") + "/";
}

/**
 * How long to wait for the bridge.
 *
 * Was 5s, on the reasoning that a login must not hang on a slow third party.
 * Measured: the same request takes ~2.3s from Bangladesh but times out at 5s
 * from the serverless region, because check_subscription.php makes its own
 * upstream call to bdApps before answering. The observed effect was
 * `carrier=TIMEOUT` on every sync - so nobody could ever be confirmed, and a
 * paying subscriber stayed on FREE.
 *
 * 12s is under the route's own 30s ceiling and still bounded. Tunable by env
 * because it is a third-party host we do not control.
 */
const TIMEOUT_MS = Number(process.env.BDAPPS_TIMEOUT_MS ?? 12000);

/**
 * How a failed or negative check is treated.
 *
 *   "log"     — record the outcome, allow the login through regardless.
 *   "enforce" — reject when the gateway says the number is not a subscriber.
 *
 * Default is "log" ON PURPOSE. Switching straight to "enforce" against a
 * third-party response shape nobody has observed server-side risks locking out
 * every real bdapps user at once. Run in "log" for a day, read the recorded
 * `status` values in the Vercel logs, confirm they look as expected, and only
 * then set BDAPPS_VERIFY_MODE=enforce.
 */
export type BdappsVerifyMode = "log" | "enforce";

export function bdappsVerifyMode(): BdappsVerifyMode {
  return process.env.BDAPPS_VERIFY_MODE === "enforce" ? "enforce" : "log";
}

export type BdappsCheckResult = {
  /** True only when the gateway positively identified an active subscriber. */
  subscribed: boolean;
  /** Coarse outcome, for logging and for deciding whether to enforce. */
  status:
    | "REGISTERED"
    | "NOT_REGISTERED"
    | "GATEWAY_ERROR"
    | "TIMEOUT"
    | "UNPARSEABLE";
  /** Raw gateway payload, truncated. Useful while running in "log" mode. */
  detail?: string;
};

/**
 * Decide whether a gateway payload describes an active subscriber.
 *
 * OBSERVED RESPONSE SHAPE (captured server-side 2026-09-10, non-subscriber):
 *
 *   {
 *     "subscriptionStatus": "",
 *     "isSubscribed": false,
 *     "statusCode": "E1325",
 *     "statusDetail": "Format of the address is invalid.",
 *     "version": "1.0",
 *     "subscriberId": "tel:8801711223344"
 *   }
 *
 * Two things that shape this function:
 *
 *  1. There is an explicit `isSubscribed` boolean which the Flutter helper
 *     (`_isRegistered()` in bdapps_login_screen.dart) never looks at. It is the
 *     most direct signal available, so it is checked first here. The client
 *     predates this observation; it was written against the JS reference rather
 *     than a captured response.
 *
 *  2. The gateway normalises the number itself (`tel:8801711223344` from an
 *     `01711223344` input), so we do not need to add the country code.
 *
 * The three legacy signals are still honoured, because different endpoints on
 * this gateway answer differently and we have only observed one of them:
 *   - `subscriptionStatus: "REGISTERED"`
 *   - `statusCode: "E1351"`  (send_otp refusing: already registered)
 *   - a message containing "already registered"
 *
 * Three outcomes, not two - the same distinction the reference web client
 * draws. Only an explicit UNREGISTERED under a success code is a "no";
 * an unanswered or errored check is UNKNOWN, and no caller may act on it.
 */
export function classify(
  data: Record<string, unknown>,
): "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN" {
  // Most direct signal, seen in the live payload above. Note that the bridge
  // computes it as `subscriptionStatus === "REGISTERED"`, so `false` is not a
  // verdict on its own - the status below has to be read as well.
  if (data.isSubscribed === true || data.isSubscribed === "true") {
    return "REGISTERED";
  }

  const code = String(data.statusCode ?? "");
  const status = String(data.subscriptionStatus ?? "").trim().toUpperCase();
  const message = String(data.message ?? data.statusDetail ?? "").toLowerCase();

  // send_otp refusing because the number is already on a subscription.
  if (code === "E1351" || message.includes("already registered")) {
    return "REGISTERED";
  }

  // A plain REGISTERED, whatever code came with it.
  if (status === "REGISTERED") return "REGISTERED";

  if (code === "S1000") {
    // bdApps answered. An empty status with a success code tells us nothing,
    // and must not be read as "no".
    if (!status) return "UNKNOWN";
    // Anything that is not an explicit UNREGISTERED is a subscription that
    // exists. This matters right after a payment: bdApps reports states like
    // "INITIAL CHARGING PENDING" while the first charge settles, and reading
    // those as "not subscribed" leaves someone who has just paid on FREE.
    return status === "UNREGISTERED" ? "NOT_REGISTERED" : "REGISTERED";
  }

  // E1301 / E1343: this application is not provisioned for the number's
  // operator. That is a fact about us, not about the subscriber - a bKash
  // subscriber on an unsupported operator answers this way and is still
  // paying - so it must never read as "not subscribed", or the nightly
  // reconciliation would cancel them.
  if (code === "E1301" || code === "E1343") return "UNKNOWN";

  // Nothing readable in the body at all - no code, no status. That is a
  // non-answer, not a no.
  if (!code && !status) return "UNKNOWN";

  // Everything else: the gateway answered, and not with a subscription.
  //
  // The reference web client calls every non-S1000 code "unknown", but it has
  // no entitlement to protect. We do: "unknown" means the return route hands
  // out PRO on the it-might-be-fine path AND the nightly reconciliation
  // refuses to take it back, so an account granted this way would keep PRO
  // forever. The observed non-subscriber answer from this bridge is E1951
  // ("Format of the address is invalid Or User Already UnRegistered",
  // captured live 2026-09-17 with the number echoed back intact), and E1325
  // before it. A plain "no" is the honest reading of both.
  return "NOT_REGISTERED";
}

/**
 * Ask the gateway whether `phone` is an active subscriber.
 *
 * Never throws: every failure path returns a result object, because the caller
 * has to make a policy decision (allow or reject) rather than 500.
 */
async function checkOneBase(
  base: string,
  phone: string,
): Promise<BdappsCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Form-encoded, matching what the Flutter client sends: `http.post` with a
    // Map body produces application/x-www-form-urlencoded, and the PHP endpoint
    // reads $_POST. Sending JSON here would arrive as an empty $_POST.
    const response = await fetch(`${base}check_subscription.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_mobile: phone }).toString(),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();

    if (!response.ok) {
      return {
        subscribed: false,
        status: "GATEWAY_ERROR",
        detail: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // The gateway occasionally returns HTML error pages instead of JSON.
      return {
        subscribed: false,
        status: "UNPARSEABLE",
        detail: text.slice(0, 200),
      };
    }

    const verdict = classify(data);
    return {
      subscribed: verdict === "REGISTERED",
      // UNKNOWN is reported as GATEWAY_ERROR so every caller's existing
      // "we could not tell" branch covers it: no downgrade, no login refusal.
      status: verdict === "UNKNOWN" ? "GATEWAY_ERROR" : verdict,
      detail: text.slice(0, 200),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      subscribed: false,
      status: aborted ? "TIMEOUT" : "GATEWAY_ERROR",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every configured bdApps application whether `phone` is subscribed.
 *
 * Registered on ANY of them counts - a user pays once, through one of them,
 * and the others have no idea. A definite "no" needs every base to answer
 * definitely no; if any could not be reached, the answer is GATEWAY_ERROR,
 * because an unreachable application is not evidence of anything.
 */
export async function checkBdappsSubscription(
  phone: string,
): Promise<BdappsCheckResult> {
  const bases = bdappsStatusBases();
  const results = await Promise.all(
    bases.map((base) => checkOneBase(base, phone)),
  );

  const registered = results.find((r) => r.status === "REGISTERED");
  if (registered) return registered;

  const detail = bases
    .map((base, i) => `${base}=${results[i].status}`)
    .join(" ");

  if (results.every((r) => r.status === "NOT_REGISTERED")) {
    return { subscribed: false, status: "NOT_REGISTERED", detail };
  }

  const timedOut = results.some((r) => r.status === "TIMEOUT");
  return {
    subscribed: false,
    status: timedOut ? "TIMEOUT" : "GATEWAY_ERROR",
    detail,
  };
}

/**
 * Policy wrapper: run the check, log it, and decide whether the login proceeds.
 *
 * Returns `null` to allow, or a reason string to reject.
 *
 * Note the asymmetry in "enforce" mode: a definite NOT_REGISTERED rejects, but
 * a gateway timeout or error does NOT. Their outage must not become an outage
 * for every paying bdapps user — the same last-known-good reasoning applied to
 * entitlement caching in F4.
 */
export async function enforceBdappsSubscription(
  phone: string,
): Promise<string | null> {
  const mode = bdappsVerifyMode();
  const result = await checkBdappsSubscription(phone);

  console.log("[bdapps] subscription check", {
    // Last 4 digits only: enough to correlate against gateway logs without
    // writing full subscriber numbers into Vercel's log retention.
    phone_suffix: phone.slice(-4),
    status: result.status,
    subscribed: result.subscribed,
    mode,
    detail: result.detail,
  });

  if (mode === "log") return null;

  if (result.status === "NOT_REGISTERED") {
    return "This number is not an active subscriber.";
  }

  return null;
}
