import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { encode } from "next-auth/jwt";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";
import {
  RATE_LIMITS,
  clientIp,
  enforceRateLimit,
} from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Google (Play Store build) login
// ---------------------------------------------------------------------------
//
// The Flutter client runs the Google Sign In flow on-device and sends us the
// resulting **ID token**. We verify that token against Google's public keys
// before trusting a single field inside it — this is the crucial difference
// from `/api/auth/bdapps/login`, which trusts a bare phone number. A client
// that makes up an email address gets a 401 here, because it cannot forge
// Google's signature.
//
// Wire body (POST /api/auth/google/login):
//   { "idToken": string }
//
// Response mirrors `/api/auth/login` exactly — `{ ok, token, user }` — so the
// Flutter `AuthService._extractTokenCandidates(...)` machinery works unchanged.
//
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
//
// `GOOGLE_CLIENT_IDS` is a comma-separated allow-list of OAuth client IDs that
// may appear in the token's `aud` claim. Add every client that can produce a
// token for this app:
//
//   * Android build -> the token's `aud` is the **Web** client ID, the one you
//                      pass to the plugin as `serverClientId`. This is the most
//                      common misconfiguration: putting the *Android* client ID
//                      here yields a valid-looking token that fails audience
//                      validation with a confusing error.
//   * iOS build     -> the iOS client ID.
//
// If the env var is unset we refuse every request rather than skip audience
// validation, because an unvalidated `aud` would mean a Google token issued to
// any application in the world is accepted here.

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const FREE_TRIAL_DAYS = 14;

function allowedAudiences(): string[] {
  return (process.env.GOOGLE_CLIENT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type GooglePayload = {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
};

export async function POST(request: Request) {
  const SECRET = process.env.NEXTAUTH_SECRET;
  if (!SECRET) {
    return NextResponse.json(
      { error: "NEXTAUTH_SECRET is not set on the server." },
      { status: 500 },
    );
  }

  const audiences = allowedAudiences();
  if (audiences.length === 0) {
    return NextResponse.json(
      {
        error: "GOOGLE_NOT_CONFIGURED",
        message:
          "GOOGLE_CLIENT_IDS is not set on the server. Add the OAuth client ID(s) that appear in the ID token aud claim (on Android this is the Web / serverClientId).",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    idToken?: unknown;
    id_token?: unknown;
  } | null;

  const rawToken =
    (typeof body?.idToken === "string" && body.idToken) ||
    (typeof body?.id_token === "string" && body.id_token) ||
    "";

  if (!rawToken) {
    return NextResponse.json({ error: "idToken is required." }, { status: 400 });
  }

  // Per-IP only: we have no trustworthy identifier until the token is verified,
  // and keying on an unverified claim would let an attacker choose their own
  // bucket. Verification costs a JWKS lookup plus a signature check, so this
  // caps the CPU an unauthenticated caller can burn. Deliberately generous —
  // every subscriber on a mobile carrier shares one public address, so a tight
  // bucket here locks out real users rather than attackers. The per-account
  // limit further down is the one that does the real work.
  const limited = await enforceRateLimit(
    [`google:ip:${clientIp(request)}`],
    RATE_LIMITS.googleLogin,
  );
  if (limited) return limited;

  // Verify the token. Signature, issuer, audience and expiry are all checked
  // by `jwtVerify`; anything that fails throws and lands in the catch below.
  let claims: GooglePayload;
  try {
    const { payload } = await jwtVerify(rawToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
    });
    claims = payload as GooglePayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[google/login] token verification failed:", message);
    return NextResponse.json(
      { error: "INVALID_GOOGLE_TOKEN", message },
      { status: 401 },
    );
  }

  const email =
    typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) {
    return NextResponse.json(
      { error: "Google token carried no email address." },
      { status: 400 },
    );
  }

  // Google reports `email_verified: false` for some federated Workspace
  // accounts. We refuse those: an unverified address would let someone sign in
  // as an address they do not actually control.
  const emailVerified =
    claims.email_verified === true || claims.email_verified === "true";
  if (!emailVerified) {
    return NextResponse.json(
      {
        error: "EMAIL_NOT_VERIFIED",
        message: "This Google account email address is not verified.",
      },
      { status: 403 },
    );
  }

  const displayName =
    (typeof claims.name === "string" && claims.name.trim()) ||
    email.split("@")[0];

  const googleSub = typeof claims.sub === "string" ? claims.sub : null;
  if (!googleSub) {
    return NextResponse.json(
      { error: "Google token carried no subject claim." },
      { status: 400 },
    );
  }

  // Second gate, now that Google's signature has vouched for `sub`. This is
  // the bucket that actually throttles one account, and unlike the IP gate
  // above it cannot be diluted by NAT or chosen by the caller.
  const subjectLimited = await enforceRateLimit(
    [`google:sub:${googleSub}`],
    RATE_LIMITS.googleLoginSubject,
  );
  if (subjectLimited) return subjectLimited;

  // Find or create the local user.
  //
  // Match on `google_sub` FIRST. Google's `sub` is permanently stable, whereas
  // the email on a Workspace account can be renamed — or, worse, released and
  // reassigned to a different person, who would then inherit the previous
  // owner's account if we matched on email alone.
  let user = await prisma.user.findUnique({ where: { google_sub: googleSub } });

  if (!user) {
    // No `sub` match. Fall back to email so pre-existing accounts (including
    // ones created before this column existed) link rather than duplicate, and
    // record the `sub` so every later sign-in takes the stable path above.
    //
    // Safe because Google has already attested `email_verified` for this
    // address above — we are not trusting a client-supplied claim.
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { google_sub: googleSub },
      });
    }
  }

  if (!user) {
    // Google-authenticated users never type a password here, so we store an
    // unguessable random hash. That stops `/api/auth/login` matching them with
    // an empty string — the same defence the bdapps route uses.
    const passwordHash = await bcrypt.hash(
      `google:${email}:${Date.now()}:${Math.random()}`,
      10,
    );

    try {
      user = await prisma.$transaction(async (tx) => {
        const freePlan = await tx.plan.findUnique({ where: { name: "FREE" } });
        if (!freePlan) {
          throw new Error(
            "FREE plan is missing. Run `npm run db:seed` before accepting Google logins.",
          );
        }

        const created = await tx.user.create({
          data: {
            email,
            password_hash: passwordHash,
            full_name: displayName,
            // Google already proved ownership of the address.
            is_verified: true,
            provider: "google",
            google_sub: googleSub,
          },
        });

        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setDate(periodEnd.getDate() + FREE_TRIAL_DAYS);

        await tx.subscription.create({
          data: {
            user_id: created.id,
            plan_id: freePlan.id,
            status: "TRIALING",
            current_period_start: now,
            current_period_end: periodEnd,
          },
        });

        return created;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[google/login] account creation failed:", message);
      return NextResponse.json(
        { error: "Failed to create account.", details: message },
        { status: 500 },
      );
    }
  }

  if (!user.is_active || user.deleted_at) {
    return NextResponse.json({ error: "Account is disabled." }, { status: 403 });
  }

  // Mint the same NextAuth JWT every other login route returns.
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
    name:
      process.env.NODE_ENV === "production"
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
