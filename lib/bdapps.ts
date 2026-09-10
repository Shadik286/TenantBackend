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
 * Gateway base. Mirrors `kBdappsBase` in the Flutter client
 * (`lib/auth_service.dart`) — note the URL-encoded `&` in the path segment.
 */
const BDAPPS_BASE = "https://androidcontentapp.xyz/SDKRent%26Tenand/";

/** Give up quickly: a login must not hang on a slow third party. */
const TIMEOUT_MS = 5000;

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
 * Deliberately strict: only an affirmative signal counts as subscribed.
 * Anything unrecognised is NOT_REGISTERED, which in "log" mode is harmless and
 * in "enforce" mode fails closed.
 */
function looksRegistered(data: Record<string, unknown>): boolean {
  // Most direct signal, seen in the live payload above.
  if (data.isSubscribed === true || data.isSubscribed === "true") return true;

  const status = String(data.subscriptionStatus ?? "").toUpperCase();
  if (status === "REGISTERED") return true;
  if (String(data.statusCode ?? "") === "E1351") return true;

  const message = String(
    data.message ?? data.statusDetail ?? "",
  ).toLowerCase();
  return message.includes("already registered");
}

/**
 * Ask the gateway whether `phone` is an active subscriber.
 *
 * Never throws: every failure path returns a result object, because the caller
 * has to make a policy decision (allow or reject) rather than 500.
 */
export async function checkBdappsSubscription(
  phone: string,
): Promise<BdappsCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // Form-encoded, matching what the Flutter client sends: `http.post` with a
    // Map body produces application/x-www-form-urlencoded, and the PHP endpoint
    // reads $_POST. Sending JSON here would arrive as an empty $_POST.
    const response = await fetch(`${BDAPPS_BASE}check_subscription.php`, {
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

    const registered = looksRegistered(data);
    return {
      subscribed: registered,
      status: registered ? "REGISTERED" : "NOT_REGISTERED",
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
