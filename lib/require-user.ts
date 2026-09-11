import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { decode } from "next-auth/jwt";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";

/**
 * Confirm the account behind a decoded token is still allowed to act.
 *
 * Two things a signature check cannot tell us:
 *
 *   1. Whether the token was revoked. Access JWTs are stateless, so the only
 *      way to kill one before it expires is to version them: every token
 *      carries the `tv` it was minted at, and a bump to `User.token_version`
 *      strands every token below it. This is what closes SEC-004a.
 *   2. Whether the account was disabled or deleted after the token was
 *      issued. Previously a deactivated user kept full access until their
 *      token expired.
 *
 * Costs one indexed primary-key lookup per request, which is the price of
 * being able to revoke at all.
 *
 * Tokens minted before `tv` existed have no claim. Those are treated as
 * version 0 rather than rejected, so shipping this does not sign every
 * existing user out — and the first revocation for a user bumps them past it
 * permanently.
 */
async function assertLiveUser(
  userId: string,
  tokenVersion: number | undefined,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { token_version: true, is_active: true, deleted_at: true },
  });
  if (!user) return false;
  if (!user.is_active || user.deleted_at) return false;
  return (tokenVersion ?? 0) >= user.token_version;
}

function unauthorized(reason: string): NextResponse {
  return NextResponse.json({ error: "Unauthorized", reason }, { status: 401 });
}

/**
 * Returns the authenticated user's id, or a 401 NextResponse if no session.
 *
 * Authentication is accepted in two forms, in this priority order:
 *   1. `Authorization: Bearer <jwt>`  - set by the Flutter client from the
 *      `/api/auth/login` response body. This is the supported path for native
 *      mobile because cookie handling on Android/iOS is unreliable.
 *   2. The NextAuth session cookie (`next-auth.session-token` or the `__Secure-`
 *      variant in production). Decoded via `getServerSession` in `auth.ts`.
 *
 * Routes under `/api/v1/users/me/*` should call this first.
 */
export async function requireUserId(): Promise<
  { userId: string; session: Session } | { response: NextResponse }
> {
  const SECRET = process.env.NEXTAUTH_SECRET;
  const COOKIE_NAME =
    process.env.NODE_ENV === "production"
      ? "__Secure-next-auth.session-token"
      : "next-auth.session-token";

  // 1) Bearer-token path: read raw from headers so we don't depend on a
  // pre-validated cookie jar. We decode the JWT ourselves with the same
  // secret NextAuth uses, so the payload is identical to what the cookie
  // path produces.
  const hdrs = await headers();
  const authz = hdrs.get("authorization") ?? "";
  if (authz.toLowerCase().startsWith("bearer ")) {
    const raw = authz.slice(7).trim();
    if (raw && SECRET) {
      try {
        const decoded = (await decode({ token: raw, secret: SECRET })) as
          | { id?: string; sub?: string; tv?: number }
          | null;
        const userId = decoded?.id ?? decoded?.sub;
        if (userId) {
          if (!(await assertLiveUser(userId, decoded?.tv))) {
            // A revoked or disabled account must not fall through to the
            // cookie path — the same dead token is very likely sitting in
            // the cookie jar too, and trying it again would undo the check.
            return { response: unauthorized("TOKEN_REVOKED") };
          }
          // Synthesize a minimal Session so downstream code that reads
          // `session.user` keeps working. We can't fabricate the full NextAuth
          // session object, but we only ever read `userId` from it here.
          const session = {
            user: {
              id: userId,
              email: null,
              name: null,
              image: null,
            },
            expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          } as unknown as Session;
          return { userId, session };
        }
      } catch {
        // Fall through to the cookie path; a malformed bearer must not
        // short-circuit the cookie lookup that might still succeed.
      }
    }
  }

  // The cookie carries the same claims as the bearer token, so read `tv` from
  // it once and reuse it for both cookie paths below. `auth()` surfaces the
  // session but not the raw claims, and a cookie session has to be revocable
  // on the same terms as a bearer one.
  let cookieToken: string | undefined;
  let cookieTv: number | undefined;
  if (SECRET) {
    const store = await cookies();
    cookieToken = (
      store.get(COOKIE_NAME) ?? store.get("__Secure-" + COOKIE_NAME)
    )?.value;
    if (cookieToken) {
      try {
        const claims = (await decode({
          token: cookieToken,
          secret: SECRET,
        })) as { tv?: number } | null;
        cookieTv = claims?.tv;
      } catch {
        // Unreadable claims leave `cookieTv` undefined, which assertLiveUser
        // treats as version 0 — the same as a pre-versioning token.
      }
    }
  }

  // 2) NextAuth cookie path (and as a fallback for malformed bearer tokens).
  const session = await auth();
  if (session?.user?.id) {
    if (!(await assertLiveUser(session.user.id, cookieTv))) {
      return { response: unauthorized("TOKEN_REVOKED") };
    }
    return { userId: session.user.id, session };
  }

  // 3) Manual cookie decode: when the NextAuth JWT is present but for some
  // reason `getServerSession` returned null (e.g. a stale token decoded
  // against a rotated secret on a server restart), still try to read it
  // directly so we don't 401 the user mid-session.
  if (SECRET && cookieToken) {
    try {
      const decoded = (await decode({
        token: cookieToken,
        secret: SECRET,
      })) as { id?: string; sub?: string; tv?: number } | null;
      const userId = decoded?.id ?? decoded?.sub;
      if (userId) {
        if (!(await assertLiveUser(userId, decoded?.tv))) {
          return { response: unauthorized("TOKEN_REVOKED") };
        }
        return {
          userId,
          session: { user: { id: userId } } as unknown as Session,
        };
      }
    } catch {
      // ignore; fall through to 401
    }
  }

  return { response: unauthorized("NO_SESSION") };
}