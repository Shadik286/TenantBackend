import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { decode } from "next-auth/jwt";
import { auth } from "@/auth";
import type { Session } from "next-auth";

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
          | { id?: string; sub?: string }
          | null;
        const userId = decoded?.id ?? decoded?.sub;
        if (userId) {
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

  // 2) NextAuth cookie path (and as a fallback for malformed bearer tokens).
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, session };
  }

  // 3) Manual cookie decode: when the NextAuth JWT is present but for some
  // reason `getServerSession` returned null (e.g. a stale token decoded
  // against a rotated secret on a server restart), still try to read it
  // directly so we don't 401 the user mid-session.
  if (SECRET) {
    const store = await cookies();
    const tokenCookie =
      store.get(COOKIE_NAME) ?? store.get("__Secure-" + COOKIE_NAME);
    if (tokenCookie?.value) {
      try {
        const decoded = (await decode({
          token: tokenCookie.value,
          secret: SECRET,
        })) as { id?: string; sub?: string } | null;
        const userId = decoded?.id ?? decoded?.sub;
        if (userId) {
          return {
            userId,
            session: { user: { id: userId } } as unknown as Session,
          };
        }
      } catch {
        // ignore; fall through to 401
      }
    }
  }

  return {
    response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  };
}