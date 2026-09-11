import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { revokeAllSessions } from "@/lib/auth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/auth/sessions/revoke-all
// ---------------------------------------------------------------------------
//
// "Sign out everywhere." Revokes every refresh token the user holds and bumps
// `token_version`, which strands access tokens already in flight.
//
// Note this signs out the CALLER too — their own access token is below the new
// version the moment this returns. That is intentional: the button exists for
// "my phone was stolen", and a version bump that spared the caller would spare
// the thief if the thief is the one holding the stolen device.
//
// The client should treat a 200 here as a full sign-out: wipe the keystore,
// clear the local PIN, and route to login.

export async function POST() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  await revokeAllSessions(guard.userId);

  const response = NextResponse.json({
    ok: true,
    message: "All sessions signed out.",
  });

  response.cookies.set({
    name:
      process.env.NODE_ENV === "production"
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}
