import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  issueRefreshToken,
  mintAccessToken,
} from "@/lib/auth/tokens";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  RATE_LIMITS,
  clientIp,
  enforceRateLimit,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

const SECRET = process.env.NEXTAUTH_SECRET;
const COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

// Strip everything that isn't part of a real phone number so users can log in
// regardless of formatting ("+212 6 12 34 56 78" and "00212612345678" both
// resolve to the same account).
function normalizePhone(input: string): string {
  return input.replace(/[^\d+]/g, "");
}

export async function POST(request: Request) {
  if (!SECRET) {
    return NextResponse.json(
      { error: "NEXTAUTH_SECRET is not set on the server." },
      { status: 500 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    identifier?: unknown;
    phone?: unknown;
    password?: unknown;
  } | null;

  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return NextResponse.json(
      { error: "password is required." },
      { status: 400 }
    );
  }

  // Accept any of: "email", "phone", or generic "identifier". We treat the
  // value as an email when it contains "@", otherwise as a phone.
  const rawIdentifier =
    (typeof body?.identifier === "string" && body.identifier) ||
    (typeof body?.email === "string" && body.email) ||
    (typeof body?.phone === "string" && body.phone) ||
    "";

  if (!rawIdentifier) {
    return NextResponse.json(
      { error: "email or phone is required." },
      { status: 400 }
    );
  }

  const identifier = rawIdentifier.trim();
  const looksLikeEmail = identifier.includes("@");

  // Throttle before touching the database or running bcrypt. Two independent
  // buckets: one per source IP (stops a single host spraying many accounts)
  // and one per identifier (stops a distributed attempt on one account).
  // Placed after parsing so we have the identifier, but before any lookup so a
  // blocked attacker never costs us a query or a hash comparison.
  const limited = await enforceRateLimit(
    [
      `login:ip:${clientIp(request)}`,
      `login:id:${identifier.toLowerCase()}`,
    ],
    RATE_LIMITS.login,
  );
  if (limited) return limited;

  // Strict rule: the email branch only fires when the input looks like a real
  // email address (must contain "@" and a "." after the host). Anything else
  // is treated as a phone number and routed through `normalizePhone`.
  if (looksLikeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    return NextResponse.json(
      { error: "Identifier must be a valid email or phone number." },
      { status: 400 }
    );
  }

  const normalizedPhone = normalizePhone(identifier);
  const phoneDigits = normalizedPhone.replace(/[^\d]/g, "");

  let user: User | null;
  if (looksLikeEmail) {
    user = await prisma.user.findUnique({
      where: { email: identifier.toLowerCase() },
    });
  } else {
    // Phone branch only fires when the value contains at least 8 digits,
    // blocking any "test5"-style identifier with no '@' from matching.
    if (phoneDigits.length < 8) {
      return NextResponse.json(
        { error: "Phone number looks too short." },
        { status: 400 }
      );
    }
    user = await prisma.user.findFirst({
      where: { phone: normalizedPhone },
    });
  }

  if (!user || !user.is_active || user.deleted_at) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  // `mintAccessToken` encodes both `sub` and a top-level `id` claim so the
  // NextAuth `session` callback in `auth.ts` can populate `session.user.id`.
  // Without `id`, the `session` callback's `token.id` is undefined and
  // `requireUserId()` answers 401 even when the cookie was sent. It also
  // stamps `tv`, the token version that makes this token revocable.
  const token = await mintAccessToken(user);
  const refresh = await issueRefreshToken(
    user.id,
    request.headers.get("user-agent"),
  );

  const response = NextResponse.json({
    ok: true,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt.toISOString(),
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    // Mobile clients (Flutter on Android/iOS) are notoriously flaky with
    // cookie jars, so we ALSO ship the JWT in the body. The Flutter
    // `ApiClient._headers()` reads it and re-sends it as
    // `Authorization: Bearer <token>` on every subsequent request.
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
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
