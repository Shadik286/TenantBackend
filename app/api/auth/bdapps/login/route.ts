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

  // 1) Look up an existing user by phone, or create one with the PRO plan.
  let user: User | null = await prisma.user.findFirst({
    where: { phone: normalizedPhone },
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
            "PRO plan is missing. Run `npm run db:seed` before accepting bdapps logins."
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

  // 2) Mint the same NextAuth JWT the standard login returns so Flutter's
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
