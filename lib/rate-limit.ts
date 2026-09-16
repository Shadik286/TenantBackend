import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * DB-backed sliding-window rate limiter.
 *
 * Why the database and not an in-memory counter: this API runs as Vercel
 * serverless functions. Every invocation may land on a fresh instance, so
 * process-local state counts nothing — an attacker spraying requests would
 * simply hit a different lambda each time. The `RateLimitToken` table is the
 * only shared state we have, and it was designed for exactly this (see
 * `prisma/schema.prisma`, indexed on `[key, created_at]`).
 *
 * Algorithm — sliding window log:
 *   1. Count the rows for `key` created inside the window.
 *   2. If that count has reached the limit, deny and report when the oldest
 *      row falls out of the window (that is when a slot frees up).
 *   3. Otherwise record a row and allow.
 *
 * There is a benign race: two concurrent requests can both count `limit - 1`
 * and both insert. That over-permits by a request or two under a burst, which
 * is irrelevant for brute-force defence — the attacker still cannot get more
 * than a handful of attempts per window. Serialising it with a transaction
 * would cost a held connection on every login for no security gain.
 *
 * FAIL-OPEN by design: if the rate-limit query itself throws, we allow the
 * request through and log loudly. A bug or a hiccup in this helper must never
 * lock every user out of their account — that would be a self-inflicted denial
 * of service far worse than the abuse it prevents.
 */

export type RateLimitRule = {
  /** Maximum requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/**
 * Central limit table. Tuned so a legitimate user never notices:
 * a real person mistyping a password three times stays well inside `login`,
 * while a script gets 5 tries per quarter hour per IP and per account.
 */
export const RATE_LIMITS = {
  /** Password login. Applied per-IP and per-identifier independently. */
  login: { limit: 5, windowSeconds: 15 * 60 },
  /** Account creation — the main spam / storage-exhaustion vector. */
  register: { limit: 3, windowSeconds: 60 * 60 },
  /**
   * bdapps phone login. Same shape as `login`. This endpoint mints a session
   * from a phone number alone (see SEC-001), so throttling it also slows
   * phone-number enumeration until that finding is fixed properly.
   */
  bdappsLogin: { limit: 5, windowSeconds: 15 * 60 },
  /**
   * Google login, pre-verification gate. Keyed on IP, so it must tolerate
   * carrier-grade NAT: a mobile network puts thousands of subscribers behind
   * one address, and the Flutter app is exactly that traffic. This bucket
   * exists only to cap the CPU an unauthenticated caller can burn on a JWKS
   * lookup and a signature check — it is not the brute-force defence, so it
   * is set well above anything a shared exit node produces legitimately.
   * The real per-account throttle is `googleLoginSubject` below.
   */
  googleLogin: { limit: 60, windowSeconds: 15 * 60 },
  /**
   * Google login, post-verification. Keyed on the token's `sub` claim, which
   * Google signed, so a caller cannot pick their own bucket. This is the
   * bucket that actually limits one account's attempts, and it can be tight
   * because it is immune to NAT.
   */
  googleLoginSubject: { limit: 10, windowSeconds: 15 * 60 },
  /** Cloudinary uploads — 5 MB each, so this protects a paid quota. */
  upload: { limit: 20, windowSeconds: 60 * 60 },
  /**
   * Refresh-token exchange. Not a brute-force surface — the token is 256
   * bits — so this only bounds the database work an anonymous caller can
   * provoke. Generous because it is keyed on IP and a mobile carrier puts
   * thousands of subscribers behind one, each refreshing about hourly.
   */
  tokenRefresh: { limit: 300, windowSeconds: 15 * 60 },
  /**
   * Coupon redemption. Hard limit, and the tightest one here.
   *
   * A coupon namespace is enumerable in a way a token is not — codes are
   * short enough to type — and a hit grants PRO for free. Five attempts an
   * hour makes walking the space hopeless while leaving room for a user who
   * fat-fingers a code off a flyer a few times. Applied per USER, not per IP,
   * because the endpoint requires a session: an attacker would have to farm
   * accounts to widen it, and every attempt is attributable.
   */
  couponRedeem: { limit: 5, windowSeconds: 60 * 60 },
  /**
   * Starting a bdApps subscription. Each attempt writes a row and sends a
   * person to a payment page, so a stuck client retrying in a loop would both
   * fill the table and hammer the gateway. Loose enough that a user who
   * abandons the flow a few times and comes back is never blocked.
   */
  subscriptionAuthorize: { limit: 10, windowSeconds: 60 * 60 },
  /**
   * "I paid but the app says Free" recovery. Each call reaches the bdApps
   * bridge, so it is capped — but generously, because the person pressing it
   * has already paid and is not in a mood to be told to wait.
   */
  subscriptionSync: { limit: 12, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when denied. */
  retryAfterSeconds: number;
  /** Requests left in the current window. Best-effort. */
  remaining: number;
};

/**
 * Best-effort client IP.
 *
 * Vercel terminates TLS at the edge and sets `x-forwarded-for`, whose first
 * entry is the real client. We fall back through the other common headers and
 * finally to a constant, so a missing header degrades into "one shared bucket"
 * rather than into no limiting at all.
 *
 * Note this is spoofable in principle, but not on Vercel: the platform
 * overwrites `x-forwarded-for` with the observed peer address, so a client
 * cannot forge it. Behind a different proxy, verify that before trusting it.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown"
  );
}

/**
 * Check (and consume) one unit of quota for `key`.
 *
 * `key` should be namespaced by both the action and the dimension being
 * limited, e.g. `login:ip:203.0.113.4` or `login:id:someone@example.com`, so
 * the two never share a bucket.
 */
export async function checkRateLimit(
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = new Date(now - rule.windowSeconds * 1000);

  try {
    const used = await prisma.rateLimitToken.count({
      where: { key, created_at: { gte: windowStart } },
    });

    if (used >= rule.limit) {
      // A slot frees up when the oldest in-window row ages out.
      const oldest = await prisma.rateLimitToken.findFirst({
        where: { key, created_at: { gte: windowStart } },
        orderBy: { created_at: "asc" },
        select: { created_at: true },
      });

      const freesAt = oldest
        ? oldest.created_at.getTime() + rule.windowSeconds * 1000
        : now + rule.windowSeconds * 1000;

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now) / 1000)),
        remaining: 0,
      };
    }

    await prisma.rateLimitToken.create({ data: { key } });

    // Opportunistic prune of this key's expired rows. Doing it on the allow
    // path keeps the table from growing without needing a cron job (this
    // project has none — see `vercel-architecture.md`, which describes crons
    // that were never implemented).
    prisma.rateLimitToken
      .deleteMany({ where: { key, created_at: { lt: windowStart } } })
      .catch(() => {
        /* pruning is housekeeping; never surface it to the caller */
      });

    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(0, rule.limit - used - 1),
    };
  } catch (err) {
    // Fail open. See the note at the top of this file.
    console.error("[rate-limit] check failed, allowing request", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, retryAfterSeconds: 0, remaining: rule.limit };
  }
}

/**
 * Standard 429 response.
 *
 * The body carries `error`, `message` and `details` because the Flutter client
 * probes those keys in that order when surfacing a failure (see
 * `_messageFromResponseBody` in `google_login_screen.dart` and the equivalent
 * extractor in `bdapps_login_screen.dart`). Without a `message` the shipped app
 * would show a bare "HTTP 429" to the user.
 */
export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const wait =
    retryAfterSeconds < 60
      ? `${retryAfterSeconds} seconds`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const message = `Too many attempts. Please try again in ${wait}.`;

  return NextResponse.json(
    {
      error: "RATE_LIMITED",
      message,
      details: message,
      retry_after_seconds: retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Convenience wrapper: enforce every supplied key against one rule and return
 * a ready-made 429 if any of them is exhausted.
 *
 * Passing several keys is how we limit the same action along more than one
 * dimension at once — per-IP *and* per-account for login, so that neither a
 * single host hammering many accounts nor a botnet targeting one account gets
 * through.
 *
 * Returns `null` when the request may proceed.
 */
export async function enforceRateLimit(
  keys: string[],
  rule: RateLimitRule,
): Promise<NextResponse | null> {
  if (keys.length === 0) return null;

  const now = Date.now();
  const windowStart = new Date(now - rule.windowSeconds * 1000);

  try {
    // ONE round trip to count every key, instead of one per key.
    //
    // This used to loop `checkRateLimit` per key, costing 2 round trips each.
    // On /api/auth/login — which limits per-IP AND per-identifier — that was 4
    // round trips before the handler even looked up the user. Against a
    // database in another region that is most of a second, paid by every
    // login attempt including the legitimate ones.
    //
    // `connection_limit=1` is why `Promise.all` would not have helped: Prisma
    // serialises queries onto the single connection regardless. The only real
    // fix is fewer queries, not more concurrency.
    const counts = await prisma.rateLimitToken.groupBy({
      by: ["key"],
      where: { key: { in: keys }, created_at: { gte: windowStart } },
      _count: { _all: true },
    });

    const used = new Map(counts.map((c) => [c.key, c._count._all]));
    const exceeded = keys.find((k) => (used.get(k) ?? 0) >= rule.limit);

    if (exceeded) {
      // Only on the deny path do we pay for a second query, to say honestly
      // when a slot frees up. Denials are rare, so the cost sits where it
      // does the least harm.
      const oldest = await prisma.rateLimitToken.findFirst({
        where: { key: exceeded, created_at: { gte: windowStart } },
        orderBy: { created_at: "asc" },
        select: { created_at: true },
      });
      const freesAt = oldest
        ? oldest.created_at.getTime() + rule.windowSeconds * 1000
        : now + rule.windowSeconds * 1000;

      console.warn("[rate-limit] blocked", { key: exceeded, rule });
      return tooManyRequests(
        Math.max(1, Math.ceil((freesAt - now) / 1000)),
      );
    }

    // ONE round trip to record every key.
    await prisma.rateLimitToken.createMany({
      data: keys.map((key) => ({ key })),
    });

    // Pruning is housekeeping, so it should not be on the hot path at all.
    // Running it ~5% of the time keeps the table bounded without adding a
    // query to every single request — there is no cron in this project to do
    // it out of band.
    if (Math.random() < 0.05) {
      prisma.rateLimitToken
        .deleteMany({ where: { key: { in: keys }, created_at: { lt: windowStart } } })
        .catch(() => {});
    }

    return null;
  } catch (err) {
    // Fail open, exactly as the per-key path does: a limiter fault must never
    // lock users out of their own accounts.
    console.error("[rate-limit] enforce failed, allowing request", {
      keys,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
