import { NextRequest, NextResponse } from "next/server";
import { rotateRefreshToken } from "@/lib/auth/tokens";
import {
  RATE_LIMITS,
  clientIp,
  enforceRateLimit,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------
//
// Exchange a refresh token for a fresh access token. This is the endpoint the
// PIN gate ends at: the PIN is checked on the device, which unlocks the
// refresh token in the keystore, which is spent here.
//
// Wire body:  { "refreshToken": string, "deviceLabel"?: string }
// Response :  { ok, token, refreshToken, expiresInSeconds, user }
//
// `token` is named to match every other auth route so the Flutter
// `AuthService._extractTokenCandidates(...)` machinery works unchanged.
//
// The refresh token ROTATES: the value sent here is dead once this returns,
// and the client must persist the new one. Presenting an already-rotated
// token is treated as a replay and kills every session the user has — see
// `rotateRefreshToken`.

export async function POST(request: NextRequest) {
  // Guessing a refresh token is not a threat (256 bits of entropy), so this
  // cap exists only to bound the database work an anonymous caller can
  // provoke. Set well above what a mobile carrier's shared exit address
  // produces legitimately — a device refreshes about once an hour.
  const limited = await enforceRateLimit(
    [`refresh:ip:${clientIp(request)}`],
    RATE_LIMITS.tokenRefresh,
  );
  if (limited) return limited;

  const body = (await request.json().catch(() => null)) as {
    refreshToken?: unknown;
    refresh_token?: unknown;
    deviceLabel?: unknown;
    device_label?: unknown;
  } | null;

  const raw =
    (typeof body?.refreshToken === "string" && body.refreshToken) ||
    (typeof body?.refresh_token === "string" && body.refresh_token) ||
    "";

  if (!raw) {
    return NextResponse.json(
      { error: "REFRESH_TOKEN_REQUIRED", message: "refreshToken is required." },
      { status: 400 },
    );
  }

  const deviceLabel =
    (typeof body?.deviceLabel === "string" && body.deviceLabel) ||
    (typeof body?.device_label === "string" && body.device_label) ||
    null;

  const result = await rotateRefreshToken(raw, deviceLabel);

  if (!result.ok) {
    // Every failure answers 401 with the same message, because the client's
    // job is identical in all four cases: wipe local state and send the user
    // through a real login.
    //
    // `reason` is included for debugging. It does distinguish "no such token"
    // from "expired", which would matter if tokens were guessable — but they
    // are 256 bits of randomness, so an attacker cannot produce a candidate
    // to learn anything about in the first place.
    return NextResponse.json(
      {
        error: "REFRESH_REJECTED",
        reason: result.reason,
        message: "Your session has expired. Please sign in again.",
      },
      { status: 401 },
    );
  }

  return NextResponse.json({
    ok: true,
    token: result.accessToken,
    refreshToken: result.refreshToken,
    refreshExpiresAt: result.refreshExpiresAt.toISOString(),
    expiresInSeconds: result.expiresInSeconds,
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.full_name,
      phone: result.user.phone,
    },
  });
}
