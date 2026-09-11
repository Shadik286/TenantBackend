import { NextRequest, NextResponse } from "next/server";
import { revokeRefreshToken } from "@/lib/auth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
//
// Sign out one device: revoke the refresh token it holds and clear the session
// cookie. The access token is left to expire on its own — it has at most an
// hour to live, and bumping `token_version` to kill it early would sign the
// user out of their other devices too, which is not what "log out" means here.
// Use POST /api/auth/sessions/revoke-all for that.
//
// Wire body: { "refreshToken"?: string }
//
// Always answers 200. The caller is signing out; there is no failure mode
// worth reporting, and confirming whether a token existed would help someone
// probing tokens.

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    refreshToken?: unknown;
    refresh_token?: unknown;
  } | null;

  const raw =
    (typeof body?.refreshToken === "string" && body.refreshToken) ||
    (typeof body?.refresh_token === "string" && body.refresh_token) ||
    "";

  if (raw) {
    await revokeRefreshToken(raw);
  }

  const response = NextResponse.json({ ok: true });

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
