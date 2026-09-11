import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/v1/coupons/redeem
// ---------------------------------------------------------------------------
//
// Wire body: { "code": "K7QF-2M9X-TD" }
//
// Two coupon types, and they take different routes into the user's account:
//
//   TRIAL_EXTENSION  moves Subscription.current_period_end forward. "Your
//                    trial is longer" is precisely what that column means, so
//                    there is nothing to invent.
//   FREE_PRO         grants PRO limits for a window without touching the
//                    subscription. `getPlanForOwner` reads it as priority 1
//                    and it lapses on its own, leaving whatever the user
//                    actually pays for intact underneath.
//
// Everything below runs in one transaction. A coupon with a redemption cap is
// a finite resource being handed out concurrently, so the read that checks the
// cap and the write that consumes it cannot be separate statements.

/** Uppercase, and strip the dashes people type from a printed code. */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "");
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const userId = guard.userId;

  // Per-user, not per-IP: the endpoint needs a session, so this is
  // attributable and cannot be widened by changing address.
  const limited = await enforceRateLimit(
    [`coupon:user:${userId}`],
    RATE_LIMITS.couponRedeem,
  );
  if (limited) return limited;

  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
  } | null;

  const rawCode = typeof body?.code === "string" ? body.code : "";
  const code = normalizeCode(rawCode);
  if (!code) {
    return NextResponse.json(
      { error: "CODE_REQUIRED", message: "Enter a coupon code." },
      { status: 400 },
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const coupon = await tx.coupon.findUnique({ where: { code } });

      // One message for "no such coupon" and for "not valid right now". A
      // distinct "that code exists but has expired" would confirm hits to
      // someone walking the namespace, which is exactly what the rate limit
      // is there to stop.
      const now = new Date();
      const unusable =
        !coupon ||
        !coupon.is_active ||
        (coupon.valid_from && coupon.valid_from > now) ||
        (coupon.valid_until && coupon.valid_until < now);

      if (unusable) {
        return { kind: "INVALID" as const };
      }

      // Consume a redemption slot. Expressed as a conditional UPDATE rather
      // than read-then-write so two callers racing for the last slot cannot
      // both win: whoever loses matches zero rows.
      if (coupon.max_redemptions !== null) {
        const consumed = await tx.coupon.updateMany({
          where: {
            id: coupon.id,
            redemptions_used: { lt: coupon.max_redemptions },
          },
          data: { redemptions_used: { increment: 1 } },
        });
        if (consumed.count === 0) {
          return { kind: "EXHAUSTED" as const };
        }
      } else {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { redemptions_used: { increment: 1 } },
        });
      }

      const grantMs = coupon.value_days * 24 * 60 * 60 * 1000;
      let expiresAt = new Date(now.getTime() + grantMs);

      if (coupon.type === "TRIAL_EXTENSION") {
        const subscription = await tx.subscription.findUnique({
          where: { user_id: userId },
        });
        if (subscription) {
          // Extend from the current end date when the trial still has time on
          // it, so redeeming early is not a penalty. Only fall back to "from
          // now" once it has already lapsed.
          const base =
            subscription.current_period_end > now
              ? subscription.current_period_end
              : now;
          expiresAt = new Date(base.getTime() + grantMs);
          await tx.subscription.update({
            where: { user_id: userId },
            data: { current_period_end: expiresAt },
          });
        }
      }

      // The unique on (coupon_id, user_id) is what enforces one-per-user. It
      // throws P2002 on a second attempt, caught below — a check-then-insert
      // would let two concurrent requests through.
      await tx.couponRedemption.create({
        data: {
          coupon_id: coupon.id,
          user_id: userId,
          expires_at: expiresAt,
        },
      });

      return {
        kind: "OK" as const,
        type: coupon.type,
        valueDays: coupon.value_days,
        expiresAt,
      };
    });

    if (result.kind === "INVALID") {
      return NextResponse.json(
        {
          error: "COUPON_INVALID",
          message: "That code is not valid.",
        },
        { status: 404 },
      );
    }

    if (result.kind === "EXHAUSTED") {
      return NextResponse.json(
        {
          error: "COUPON_EXHAUSTED",
          message: "This code has already been fully claimed.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        type: result.type,
        value_days: result.valueDays,
        expires_at: result.expiresAt.toISOString(),
        message:
          result.type === "FREE_PRO"
            ? `Pro unlocked for ${result.valueDays} days.`
            : `Your trial was extended by ${result.valueDays} days.`,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // The (coupon_id, user_id) unique fired: already redeemed by this user.
      return NextResponse.json(
        {
          error: "COUPON_ALREADY_REDEEMED",
          message: "You have already used this code.",
        },
        { status: 409 },
      );
    }
    console.error("[coupons/redeem] failed", err);
    return NextResponse.json(
      {
        error: "REDEEM_FAILED",
        message: "Could not redeem that code. Please try again.",
      },
      { status: 500 },
    );
  }
}
