import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /api/v1/users/me/pin
// ---------------------------------------------------------------------------
//
// The unlock PIN, as stored server-side.
//
// READ THIS BEFORE ADDING A "VERIFY PIN" ENDPOINT: there deliberately isn't
// one, and there must not be. A 6-digit PIN is 10^6 combinations. Any endpoint
// that answers "is this PIN correct?" is a million-guess oracle, and no amount
// of rate limiting makes that a credential — it would take one distributed
// afternoon. The PIN is verified ON THE DEVICE against a hash in the platform
// keystore, and five wrong attempts wipe the local session. That is what makes
// six digits acceptable: an attacker gets five guesses, not a million.
//
// So what is this column for? Continuity across a reinstall. After the user
// re-authenticates for real (Google / bdapps OTP) the client pulls this hash
// down and keeps verifying locally, instead of making them pick a new PIN on
// every new device. Every route here requires a valid access token, so
// nothing below is reachable with the PIN alone.
//
//   GET    -> { is_set, set_at }         does this account have a PIN
//   PUT    -> { pin, currentPin? }       set or change it
//   DELETE ->                            clear it (the forgot-PIN path)

const PIN_LENGTH = 6;
const BCRYPT_ROUNDS = 10;

/**
 * Reject PINs that a shoulder-surfer or a five-guess attacker would try
 * first. Five attempts against 10^6 is fine odds; five attempts against "the
 * user probably picked 123456" is not.
 */
function weakPinReason(pin: string): string | null {
  if (!/^\d{6}$/.test(pin)) {
    return `PIN must be exactly ${PIN_LENGTH} digits.`;
  }
  if (/^(\d)\1{5}$/.test(pin)) {
    return "PIN cannot be the same digit six times.";
  }
  const digits = pin.split("").map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) {
    return "PIN cannot be six consecutive digits.";
  }
  return null;
}

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const user = await prisma.user.findUnique({
    where: { id: guard.userId },
    select: { pin_hash: true, pin_set_at: true },
  });

  return NextResponse.json({
    data: {
      is_set: Boolean(user?.pin_hash),
      set_at: user?.pin_set_at?.toISOString() ?? null,
    },
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const body = (await request.json().catch(() => null)) as {
    pin?: unknown;
    currentPin?: unknown;
    current_pin?: unknown;
  } | null;

  const pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  const currentPin =
    (typeof body?.currentPin === "string" && body.currentPin.trim()) ||
    (typeof body?.current_pin === "string" && body.current_pin.trim()) ||
    "";

  const weak = weakPinReason(pin);
  if (weak) {
    return NextResponse.json(
      { error: "WEAK_PIN", message: weak },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: guard.userId },
    select: { pin_hash: true },
  });

  // Changing an existing PIN requires the old one. This is not what protects
  // the account — the caller already holds a valid access token, which grants
  // far more than the PIN does — it stops someone who got hold of a live
  // token from quietly replacing the PIN with one they know and keeping
  // access after the token expires.
  //
  // The forgot-PIN path does not come through here: it re-authenticates,
  // calls DELETE to clear the PIN, then PUTs a new one.
  if (user?.pin_hash) {
    if (!currentPin) {
      return NextResponse.json(
        {
          error: "CURRENT_PIN_REQUIRED",
          message:
            "Enter your current PIN to change it, or reset it by signing in again.",
        },
        { status: 400 },
      );
    }
    const matches = await bcrypt.compare(currentPin, user.pin_hash);
    if (!matches) {
      return NextResponse.json(
        { error: "CURRENT_PIN_INCORRECT", message: "Current PIN is incorrect." },
        { status: 403 },
      );
    }
  }

  const hash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
  await prisma.user.update({
    where: { id: guard.userId },
    data: { pin_hash: hash, pin_set_at: new Date() },
  });

  return NextResponse.json({
    ok: true,
    data: { is_set: true, set_at: new Date().toISOString() },
  });
}

export async function DELETE() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  // Reachable only with a valid access token, which on the forgot-PIN path
  // means the user has just proven who they are through Google or the bdapps
  // OTP gateway. That is a stronger proof than the PIN it clears.
  await prisma.user.update({
    where: { id: guard.userId },
    data: { pin_hash: null, pin_set_at: null },
  });

  return NextResponse.json({ ok: true, data: { is_set: false, set_at: null } });
}
