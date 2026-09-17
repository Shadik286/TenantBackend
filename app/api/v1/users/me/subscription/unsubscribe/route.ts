import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { BDAPPS_BASE } from "@/lib/bdapps";
import { removeBkashSubscriber } from "@/lib/bdapps/subscribers";
import { probeRegistrationViaOtp } from "@/lib/bdapps/otp-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/v1/users/me/subscription/unsubscribe
// ---------------------------------------------------------------------------
//
// Cancel a subscription, in the order that cannot lose the user money.
//
//   1. Cancel billing at the gateway   (unsubscribe.php)
//   2. Remove the bKash store record   (subscribers.php action=remove)
//   3. Move our plan to FREE
//
// The ordering is the point. The client did this backwards — it set our plan
// to FREE first, then called the gateway — so a gateway failure left the user
// with no PRO features AND a live carrier subscription still charging them.
// Cancelling the billing first means the worst case is the opposite and much
// milder: billing stopped, PRO briefly retained.
//
// Step 2 matters because bKash subscriptions live only in that local store.
// `unsubscribe.php` cancels the CARRIER side; leaving the store record behind
// would let a cancelled user keep passing the subscription check forever —
// the mirror image of the bug that left a paying user on Free.

const GATEWAY_TIMEOUT_MS = 15_000;

async function callGatewayUnsubscribe(phone: string): Promise<{
  ok: boolean;
  detail: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetch(`${BDAPPS_BASE}unsubscribe.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_mobile: phone }).toString(),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };

    const data = JSON.parse(text) as Record<string, unknown>;
    // unsubscribe.php already folds bdApps' reply into a boolean: S1000, or a
    // subscriptionStatus of UNREGISTERED (already cancelled, which is success
    // from the user's point of view).
    return { ok: data.success === true, detail: text.slice(0, 200) };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the failure was the connection rather than bdApps' answer - the
 * cases where the cancellation may well have happened anyway.
 */
function isTransportFailure(detail: string): boolean {
  return /curl failed|connection reset|timed out|timeout|aborted|recv failure|HTTP 5\d\d/i.test(
    detail,
  );
}

export async function POST() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const user = await prisma.user.findUnique({
    where: { id: guard.userId },
    select: { phone: true },
  });

  let gatewayDetail = "no phone on file";

  if (user?.phone) {
    const gateway = await callGatewayUnsubscribe(user.phone);
    gatewayDetail = gateway.detail;

    // A failed call is not the same as a refused one. Observed live: the
    // bridge's request to bdApps died with "Connection reset by peer", so it
    // reported failure - but bdApps had already cancelled the subscription.
    // The request landed and only the answer was lost, and taking that at face
    // value left the account on PRO with nothing being billed.
    //
    // So when the call itself failed, ask bdApps what actually happened. The
    // OTP request answers E1351 while the subscription still exists (and sends
    // nothing); if it issues an OTP instead, the cancellation went through.
    if (!gateway.ok && isTransportFailure(gateway.detail)) {
      const after = await probeRegistrationViaOtp(user.phone);
      console.warn("[unsubscribe] call failed in transit, asked bdApps", {
        userId: guard.userId,
        detail: gateway.detail,
        nowRegistered: after.status,
      });
      if (after.status === "NOT_REGISTERED") {
        gateway.ok = true;
        gatewayDetail = `${gateway.detail} | verified cancelled: ${after.detail}`;
      }
    }

    if (!gateway.ok) {
      // Stop here. Downgrading now would strip their PRO features while the
      // carrier keeps billing them — the one outcome worth refusing.
      console.error("[unsubscribe] gateway refused, plan left unchanged", {
        userId: guard.userId,
        detail: gateway.detail,
      });
      return NextResponse.json(
        {
          error: "GATEWAY_UNSUBSCRIBE_FAILED",
          message:
            "We could not cancel your subscription with the payment provider. "
            + "Your plan is unchanged so you are not left paying for nothing. "
            + "Please try again shortly.",
        },
        { status: 502 },
      );
    }

    // Billing is cancelled; now drop the local bKash record.
    await removeBkashSubscriber(user.phone);
  }

  const freePlan = await prisma.plan.findFirst({
    where: { name: "FREE", is_active: true },
    select: { id: true },
  });

  if (freePlan) {
    // Their houses, units and tenants stay. They simply become over-limit
    // until they trim down — see lib/plans/over-limit.ts.
    await prisma.subscription.updateMany({
      where: { user_id: guard.userId },
      data: {
        plan_id: freePlan.id,
        status: "CANCELLED",
        cancelled_at: new Date(),
      },
    });
  }

  console.log("[unsubscribe] complete", {
    userId: guard.userId,
    gatewayDetail,
  });

  return NextResponse.json({
    ok: true,
    data: {
      plan_name: "FREE",
      message:
        "Your subscription has been cancelled. You are now on the Free plan.",
    },
  });
}
