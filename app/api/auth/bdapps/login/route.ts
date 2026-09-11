import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  issueRefreshToken,
  mintAccessToken,
} from "@/lib/auth/tokens";
import type { User } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enforceBdappsSubscription } from "@/lib/bdapps";
import { activeCouponEntitlement } from "@/lib/plans/get-plan";
import {
  RATE_LIMITS,
  clientIp,
  enforceRateLimit,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// bdapps-format login
// ---------------------------------------------------------------------------
//
// The bdapps gateway (androidcontentapp.xyz / Weather365SDK) handles the
// subscription check, the OTP request, and the OTP verification entirely
// client-side. Our backend is NEVER involved in those steps — there is no
// `verify_otp.php` round-trip here, we don't re-check the subscription, and
// we don't trust the OTP the Flutter app sends.
//
// All this route does is:
//   1. Look up the user by phone (already-registered case), OR
//   2. Create a brand-new user with a PRO subscription if the phone is
//      new to our database.
//   3. Mint a 30-day NextAuth JWT and return it so the Flutter app can
//      hit `/api/v1/users/...`, `/api/houses`, etc. without 401-ing.
//
// The Pro subscription is a product decision: bdapps users are paying
// customers via the gateway, so the moment they show up here we treat
// them as PRO. There's no separate "activate subscription" step.
//
// Wire body accepted from the Flutter client (POST /api/auth/bdapps/login):
//   {
//     "phone":  string,  // E.164 or local digits — we just store as-is
//     "name":   string?  // optional display name (new users only)
//   }
//
// On a 200 we return `{ ok, token, user }` matching `/api/auth/login` so
// `AuthService._extractTokenCandidates(...)` already works against the
// body without any client-side change.

const SECRET = process.env.NEXTAUTH_SECRET;
const COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

function normalizePhone(input: string): string {
  return input.replace(/[^\d+]/g, "");
}

// Build a stable, unique, RFC-ish email from a phone number. Phone numbers
// are globally unique in the User table so this is safe to use as the
// `email` placeholder (the column is required + unique).
function syntheticEmailForPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `bdapps+${digits}@tenant.local`;
}

export async function POST(request: Request) {
  if (!SECRET) {
    return NextResponse.json(
      { error: "NEXTAUTH_SECRET is not set on the server." },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    phone?: unknown;
    name?: unknown;
  } | null;

  const phoneRaw = typeof body?.phone === "string" ? body.phone.trim() : "";
  const nameRaw = typeof body?.name === "string" ? body.name.trim() : "";

  if (!phoneRaw) {
    return NextResponse.json(
      { error: "phone is required." },
      { status: 400 }
    );
  }

  const normalizedPhone = normalizePhone(phoneRaw);
  const phoneDigits = normalizedPhone.replace(/[^\d]/g, "");
  if (phoneDigits.length < 8) {
    return NextResponse.json(
      { error: "phone number looks too short." },
      { status: 400 }
    );
  }

  // This endpoint mints a 30-day session from a phone number alone (SEC-001),
  // so until that is fixed properly the rate limit is the only thing standing
  // between an attacker and walking the phone-number space. Two buckets: per
  // source IP, and per phone number so a botnet cannot grind one target.
  const limited = await enforceRateLimit(
    [
      `bdapps:ip:${clientIp(request)}`,
      `bdapps:phone:${normalizedPhone}`,
    ],
    RATE_LIMITS.bdappsLogin,
  );
  if (limited) return limited;

  // A live FREE_PRO coupon outranks the carrier subscription check. The whole
  // point of handing someone a free-PRO code is that they get PRO without
  // paying anyone, so gating it on "are you a paying bdapps subscriber" would
  // defeat it — they would be told to subscribe to use the thing that exists
  // to let them not subscribe.
  //
  // The lookup is by phone because the user row is not resolved until further
  // down; scoped to provider "bdapps" for the same reason every other lookup
  // in this file is (SEC-001: a bare phone number must not reach accounts
  // created by other flows).
  const existingBdappsUser = await prisma.user.findFirst({
    where: { phone: normalizedPhone, provider: "bdapps", deleted_at: null },
    select: { id: true },
  });
  const couponEntitlement = existingBdappsUser
    ? await activeCouponEntitlement(existingBdappsUser.id)
    : null;

  if (!couponEntitlement) {
    // Independently confirm with the gateway that this number is a real
    // subscriber, rather than trusting the caller. Runs in log-only mode until
    // BDAPPS_VERIFY_MODE=enforce — see lib/bdapps.ts for why.
    const subscriptionRejection =
      await enforceBdappsSubscription(normalizedPhone);
    if (subscriptionRejection) {
      return NextResponse.json(
        { error: "NOT_SUBSCRIBED", message: subscriptionRejection },
        { status: 403 }
      );
    }
  } else {
    console.log("[bdapps] gateway check skipped, active coupon entitlement", {
      phone_suffix: normalizedPhone.slice(-4),
      coupon_expires_at: couponEntitlement.expiresAt.toISOString(),
    });
  }

  // 1) Look up an existing bdapps user by phone, or create one with the PRO plan.
  //
  // 🔒 SEC-001: the `provider` filter is the security boundary. Without it this
  // lookup matches ANY user who happens to have this phone number on file —
  // including email/password and Google accounts — so a phone number, which is
  // printed on every rental agreement, would be a master key to their account.
  // Scoped this way, only accounts created through the bdapps flow are
  // reachable here.
  let user: User | null = await prisma.user.findFirst({
    where: { phone: normalizedPhone, provider: "bdapps" },
  });

  if (!user) {
    const email = syntheticEmailForPhone(normalizedPhone);
    const displayName =
      nameRaw.length > 0 ? nameRaw : `User ${phoneDigits.slice(-6)}`;

    try {
      user = await prisma.$transaction(async (tx) => {
        const proPlan = await tx.plan.findUnique({ where: { name: "PRO" } });
        if (!proPlan) {
          throw new Error(
            "PRO_PLAN_MISSING: run `npm run db:seed` against the target database before accepting bdapps logins."
          );
        }

        // bdapps users don't have a password — store an unguessable random
        // hash so direct /api/auth/login attempts with an empty string can't
        // match.
        const passwordHash = await bcrypt.hash(
          `bdapps:${normalizedPhone}:${Date.now()}:${Math.random()}`,
          10
        );

        const created = await tx.user.create({
          data: {
            email,
            password_hash: passwordHash,
            full_name: displayName,
            phone: normalizedPhone,
            // Must be set here, or the account this route just created is
            // invisible to the scoped lookup above on the user's next login —
            // producing a fresh empty account every single time.
            provider: "bdapps",
            // The carrier gateway ran OTP before this request reached us, so
            // this number is genuinely proven — unlike a typed one.
            phone_verified: true,
          },
        });

        // PRO never expires in this product; pick 1 year out so the
        // dashboard "ACTIVE" badge stays honest without us having to write
        // a cron.
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);

        await tx.subscription.create({
          data: {
            user_id: created.id,
            plan_id: proPlan.id,
            status: "ACTIVE",
            current_period_start: now,
            current_period_end: periodEnd,
          },
        });

        return created;
      });
    } catch (err) {
      // Surface the real failure on the server console so we don't have to
      // chase ghost bugs through the Flutter UI alone — and include the same
      // information in the response body so the app can show a useful
      // message instead of a generic "could not create bdapps account" line.
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        console.error("[bdapps/login] prisma error", {
          code: err.code,
          meta: err.meta,
          message: err.message,
        });
      } else {
        console.error("[bdapps/login] uncaught", err);
      }

      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // A concurrent request may have just created the user — re-read it,
        // scoped the same way as the primary lookup.
        user = await prisma.user.findFirst({
          where: { phone: normalizedPhone, provider: "bdapps" },
        });

        if (!user) {
          // Not a race. The unique constraint on `phone` fired because the
          // number already belongs to an account created through a DIFFERENT
          // flow (email/password or Google).
          //
          // This is SEC-001 being enforced, and it is the expected outcome of
          // the takeover attempt: we refuse rather than handing over a session.
          // Distinguished from a genuine race so it returns an honest 409
          // instead of a 500 that reads like a server bug.
          const otherProvider = await prisma.user.findFirst({
            where: { phone: normalizedPhone },
            select: { provider: true },
          });

          if (otherProvider) {
            console.warn("[bdapps/login] refused: phone owned by another provider", {
              phone_suffix: normalizedPhone.slice(-4),
              owner_provider: otherProvider.provider,
            });
            return NextResponse.json(
              {
                error: "PHONE_REGISTERED_ELSEWHERE",
                message:
                  "This number is already linked to an account that signs in a different way. Please use your original sign-in method.",
              },
              { status: 409 }
            );
          }

          return NextResponse.json(
            {
              error: "Could not finalize bdapps registration.",
              reason: "race_lost",
            },
            { status: 500 }
          );
        }
      } else if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2003"
      ) {
        // Foreign key failure — most commonly a missing PRO plan row because
        // `npm run db:seed` was never run on the target database.
        return NextResponse.json(
          {
            error: "Failed to create bdapps account.",
            reason: "missing_plan",
            details:
              "PRO plan is missing from the database. Run `npm run db:seed` against the target environment.",
          },
          { status: 500 }
        );
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json(
          {
            error: "Failed to create bdapps account.",
            reason:
              err instanceof Prisma.PrismaClientKnownRequestError
                ? err.code
                : "unknown",
            details: message,
          },
          { status: 500 }
        );
      }
    }
  }

  if (!user || !user.is_active || user.deleted_at) {
    return NextResponse.json(
      { error: "Account is disabled." },
      { status: 403 }
    );
  }

  // 2) Mint the same access/refresh pair the standard login returns so
  // Flutter's existing bearer-token machinery works unchanged, and the
  // bdapps variant gets PIN unlock on the same terms as the Google one.
  const token = await mintAccessToken(user);
  const refresh = await issueRefreshToken(
    user.id,
    request.headers.get("user-agent"),
  );

  const response = NextResponse.json({
    ok: true,
    token,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt.toISOString(),
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    user: {
      id: user.id,
      email: user.email,
      name: user.full_name,
      phone: user.phone,
    },
  });

  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
