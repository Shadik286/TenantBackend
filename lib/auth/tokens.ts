// Access tokens and refresh tokens.
//
// The shape of this module is dictated by one fact: the client unlocks with a
// 6-digit PIN. Six digits is 10^6 combinations, so a PIN can never be a remote
// credential — an attacker who could present it to an endpoint would simply
// enumerate it. So the PIN never leaves the device. What it unlocks is the
// refresh token below, which is 256 bits of entropy and revocable.
//
// That splits the session in two:
//
//   access token   short-lived (1h) NextAuth JWT, sent on every request.
//                  Stateless, so revoking it needs `token_version`.
//   refresh token  long-lived (90d) opaque random string. Stored only as a
//                  SHA-256 hash, rotated on every use, revocable per-device.
//
// Previously the client held a single 30-day JWT that nothing could revoke
// (SEC-004a).
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { encode } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";

/** Access JWT lifetime. Short, because nothing can revoke it mid-flight
 *  except a `token_version` bump. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Refresh token lifetime. Long, because it is revocable and rotated. */
export const REFRESH_TOKEN_TTL_DAYS = 90;

/** 32 bytes = 256 bits. Base64url so it survives JSON and headers intact. */
const REFRESH_TOKEN_BYTES = 32;

export type AccessTokenUser = {
  id: string;
  email: string;
  full_name: string;
  token_version: number;
};

function secret(): string {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("NEXTAUTH_SECRET is not set.");
  return s;
}

/**
 * SHA-256, hex. Not bcrypt on purpose: the input is already 256 bits of
 * uniform randomness, so there is nothing for a slow hash to protect against —
 * it cannot be guessed or dictionary-attacked, and a per-request bcrypt would
 * put ~100ms on the refresh path for no gain.
 */
export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Mint the short-lived access JWT.
 *
 * `tv` carries the user's `token_version` at mint time. `requireUserId()`
 * compares it against the column on every request, which is what makes an
 * outstanding token killable.
 */
export async function mintAccessToken(user: AccessTokenUser): Promise<string> {
  return encode({
    token: {
      sub: user.id,
      id: user.id,
      email: user.email,
      name: user.full_name,
      tv: user.token_version,
    },
    secret: secret(),
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export type IssuedRefreshToken = {
  /** The raw token. Returned exactly once — only its hash is stored. */
  token: string;
  expiresAt: Date;
};

/**
 * Issue a fresh refresh token for a device.
 *
 * Called after a real authentication (password, Google, bdapps OTP) and again
 * on every rotation.
 */
export async function issueRefreshToken(
  userId: string,
  deviceLabel?: string | null,
): Promise<IssuedRefreshToken> {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await prisma.refreshToken.create({
    data: {
      user_id: userId,
      token_hash: hashRefreshToken(token),
      device_label: deviceLabel?.slice(0, 120) || null,
      expires_at: expiresAt,
    },
  });

  return { token, expiresAt };
}

export type RefreshFailure =
  | "NOT_FOUND"
  | "EXPIRED"
  | "REVOKED_REPLAY"
  | "USER_DISABLED";

export type RefreshResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      refreshExpiresAt: Date;
      expiresInSeconds: number;
      user: { id: string; email: string; full_name: string; phone: string | null };
    }
  | { ok: false; reason: RefreshFailure };

/**
 * Exchange a refresh token for a new access token, rotating the refresh token
 * in the process.
 *
 * Rotation means a captured token is useful to an attacker only until the real
 * client next refreshes. When a token that has ALREADY been rotated is
 * presented, that is the signature of a replay: either an attacker is using a
 * stolen copy, or the legitimate client is. We cannot tell which, so we revoke
 * the user's entire family of tokens and make everyone re-authenticate. Losing
 * a session is recoverable; leaving a thief with a live one is not.
 */
export async function rotateRefreshToken(
  rawToken: string,
  deviceLabel?: string | null,
): Promise<RefreshResult> {
  const presentedHash = hashRefreshToken(rawToken);

  const existing = await prisma.refreshToken.findUnique({
    where: { token_hash: presentedHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          full_name: true,
          phone: true,
          token_version: true,
          is_active: true,
          deleted_at: true,
        },
      },
    },
  });

  if (!existing || !hashesEqual(existing.token_hash, presentedHash)) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  if (existing.revoked_at) {
    // Replay. Burn the whole family — see the note above.
    await revokeAllSessions(existing.user_id);
    return { ok: false, reason: "REVOKED_REPLAY" };
  }

  if (existing.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }

  const user = existing.user;
  if (!user.is_active || user.deleted_at) {
    return { ok: false, reason: "USER_DISABLED" };
  }

  // Revoke-then-issue in one transaction so a failure cannot leave the device
  // holding a token we already burned.
  const rotated = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { revoked_at: new Date(), last_used_at: new Date() },
    });

    const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    await tx.refreshToken.create({
      data: {
        user_id: user.id,
        token_hash: hashRefreshToken(token),
        device_label:
          deviceLabel?.slice(0, 120) || existing.device_label || null,
        expires_at: expiresAt,
      },
    });
    return { token, expiresAt };
  });

  const accessToken = await mintAccessToken({
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    token_version: user.token_version,
  });

  return {
    ok: true,
    accessToken,
    refreshToken: rotated.token,
    refreshExpiresAt: rotated.expiresAt,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      phone: user.phone,
    },
  };
}

/**
 * Revoke a single refresh token — one device signing out.
 *
 * Deliberately silent about whether the token existed: sign-out is called with
 * whatever the device happens to be holding, and a 404 here would tell an
 * attacker probing tokens which of their guesses are real.
 */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { token_hash: hashRefreshToken(rawToken), revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/**
 * Kill every session the user has: revoke all refresh tokens AND bump
 * `token_version`, which invalidates access tokens already in flight.
 *
 * Both halves matter. Revoking refresh tokens alone would still leave any
 * unexpired access token working for up to an hour.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { token_version: { increment: 1 } },
    }),
  ]);
}
