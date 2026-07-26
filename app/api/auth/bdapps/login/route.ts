import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { encode } from "next-auth/jwt";
import type { User } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// bdapps-format login
// ---------------------------------------------------------------------------
//
// Mirrors the JS reference: phone + OTP only. No password, no email collected
// from the user. On a verified OTP we:
//   1. Look up the user by phone (already-registered case).
//   2. Otherwise create one with just `full_name` + `phone`. The Prisma
//      `User.email` column is required + unique, so we synthesize a stable
//      per-phone placeholder email (`bdapps+<digits>@tenant.local`) that the
//      owner can later swap in the profile screen if they want.
//   3. Hand them the **PRO** plan by default (per product requirement: bdapps
//      users are paying customers via the gateway subscription).
//   4. Mint a 30-day NextAuth JWT and return it in the body so the Flutter
//      `ApiClient` can attach it as `Authorization: Bearer <token>` — exactly
//      the same shape the standard `/api/auth/login` returns.
//
// Wire body accepted from the Flutter client:
//   {
//     "name":           string,   // display name (used for new users)
//     "phone":          string,   // E.164-ish, "+880..." or local digits
//     "otp":            string,   // the code the user typed in
//     "referenceNo":    string,   // referenceNo from send_otp.php
//     "mode":           "subscriber-check" (optional) — skips OTP and
//                                         authorizes purely from the
//                                         gateway's subscription check.
//   }
//
// On a 200 we return `{ ok, token, user }` matching `/api/auth/login` so the
// Flutter `AuthService.login(...)` extractor already works against the body.

// The bdapps gateway the JS reference uses. Same value as in the Flutter
// client so both stay in sync if it ever needs to change.
const BDAPPS_BASE = "https://androidcontentapp.xyz/Weather365SDK";

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
// `email` placeholder.
function syntheticEmailForPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `bdapps+${digits}@tenant.local`;
}

async function verifyOtpWithGateway(opts: {
  phone: string;
  otp: string;
  referenceNo: string;
}): Promise<{ ok: boolean; statusCode?: string; message?: string }> {
  // Match the JS reference exactly: form-encoded body, x-www-form-urlencoded.
  const body = new URLSearchParams({
    Otp: opts.otp,
    referenceNo: opts.referenceNo,
    user_mobile: opts.phone,
  });
  try {
    const res = await fetch(`${BDAPPS_BASE}/verify_otp.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      // Gateway returned non-JSON; surface as a failure with the raw body.
      return { ok: false, message: text.slice(0, 200) };
    }
    const statusCode = typeof data.statusCode === "string" ? data.statusCode : "";
    return {
      ok: statusCode === "S1000",
      statusCode,
      message: typeof data.message === "string" ? data.message : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    return { ok: false, message };
  }
}

// 14-day trial window — same length as standard /register uses so the two
// flows feel identical to the user. PRO users don't expire either way but
// keeping the field populated keeps the dashboard's "TRIALING" / "ACTIVE"
// labels honest.
const FREE_TRIAL_DAYS = 14;

// Subscriber-only fast path: hit check_subscription.php directly. Used when
// the Flutter client already knows (from `check_subscription.php` or the
// E1351 / "already registered" response from `send_otp.php`) that the phone
// is subscribed. We never trust the client's word — we re-verify against the
// gateway before minting a JWT.
async function checkSubscriptionWithGateway(
  phone: string
): Promise<{ subscribed: boolean; message?: string }> {
  try {
    const res = await fetch(`${BDAPPS_BASE}/check_subscription.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_mobile: phone }),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      return { subscribed: false, message: text.slice(0, 200) };
    }
    const status =
      typeof data.subscriptionStatus === "string"
        ? data.subscriptionStatus.toUpperCase()
        : "";
    const code = typeof data.statusCode === "string" ? data.statusCode : "";
    const message =
      typeof data.message === "string" ? data.message.toLowerCase() : "";
    const subscribed =
      status === "REGISTERED" ||
      code === "E1351" ||
      message.includes("already registered");
    return { subscribed, message: typeof data.message === "string" ? data.message : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error";
    return { subscribed: false, message };
  }
}

export async function POST(request: Request) {
  if (!SECRET) {
    return NextResponse.json(
      { error: "NEXTAUTH_SECRET is not set on the server." },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    phone?: unknown;
    otp?: unknown;
    referenceNo?: unknown;
    mode?: unknown;
  } | null;

  const phoneRaw = typeof body?.phone === "string" ? body.phone.trim() : "";
  const otp = typeof body?.otp === "string" ? body.otp.trim() : "";
  const refNo = typeof body?.referenceNo === "string" ? body.referenceNo.trim() : "";
  const nameRaw = typeof body?.name === "string" ? body.name.trim() : "";
  const mode =
    typeof body?.mode === "string" && body.mode === "subscriber-check"
      ? "subscriber-check"
      : "otp";

  if (!phoneRaw) {
    return NextResponse.json(
      { error: "phone is required." },
      { status: 400 }
    );
  }
  if (mode === "otp" && (!otp || !refNo)) {
    return NextResponse.json(
      { error: "phone, otp, and referenceNo are required." },
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

  // 1) Verify the OTP / subscription against the bdapps gateway. We never
  //    trust the client.
  if (mode === "subscriber-check") {
    const check = await checkSubscriptionWithGateway(normalizedPhone);
    if (!check.subscribed) {
      return NextResponse.json(
        {
          error: check.message ?? "Phone is not subscribed.",
        },
        { status: 401 }
      );
    }
  } else {
    const verify = await verifyOtpWithGateway({
      phone: normalizedPhone,
      otp,
      referenceNo: refNo,
    });
    if (!verify.ok) {
      return NextResponse.json(
        {
          error: verify.message ?? "OTP is incorrect.",
          statusCode: verify.statusCode,
        },
        { status: 401 }
      );
    }
  }

  // 2) Look up an existing user by phone, or create one with the PRO plan.
  let user: User | null = await prisma.user.findFirst({
    where: { phone: normalizedPhone },
  });

  if (!user) {
    const email = syntheticEmailForPhone(normalizedPhone);
    const displayName = nameRaw.length > 0 ? nameRaw : `User ${phoneDigits.slice(-6)}`;

    try {
      user = await prisma.$transaction(async (tx) => {
        const proPlan = await tx.plan.findUnique({ where: { name: "PRO" } });
        if (!proPlan) {
          throw new Error(
            "PRO plan is missing. Run `npm run db:seed` before accepting bdapps logins."
          );
        }

        // bdapps users don't have a password — store an unguessable random
        // hash so direct /api/auth/login attempts with an empty string can't
        // match. `bcrypt.compare('', hash)` is guaranteed to return false,
        // but we make doubly sure by hashing a fresh random string.
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
          },
        });

        const now = new Date();
        const periodEnd = new Date(now);
        // PRO never expires in this product; pick 1 year out so the dashboard
        // "ACTIVE" badge stays honest without us having to write a cron.
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
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // A concurrent request just created the user — re-read it.
        user = await prisma.user.findFirst({
          where: { phone: normalizedPhone },
        });
        if (!user) {
          return NextResponse.json(
            { error: "Could not finalize bdapps registration." },
            { status: 500 }
          );
        }
      } else {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json(
          { error: "Failed to create bdapps account.", details: message },
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

  // 3) Mint the same NextAuth JWT the standard login returns so Flutter's
  // existing bearer-token machinery works without any client-side change.
  const token = await encode({
    token: {
      sub: user.id,
      id: user.id,
      email: user.email,
      name: user.full_name,
    },
    secret: SECRET,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  const response = NextResponse.json({
    ok: true,
    token,
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
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}