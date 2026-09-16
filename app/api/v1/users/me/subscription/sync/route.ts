import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { syncSubscriptionWithBdapps } from "@/lib/plans/sync";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/v1/users/me/subscription/sync
// ---------------------------------------------------------------------------
//
// "I paid, but the app still says Free." — the user-facing recovery for it.
//
// Asks bdApps what this user's number is actually subscribed to and makes our
// record match. It is the same reconciliation the nightly cron runs, just on
// demand for one account, so the two cannot apply different rules.
//
// Worth having as an explicit button rather than only a background job:
// someone who has just paid and been told "Free" will not wait until 2am, and
// without this their only options are to contact support or pay again.
//
// Rate limited because each call reaches a third-party gateway.

export async function POST() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const limited = await enforceRateLimit(
    [`subsync:user:${guard.userId}`],
    RATE_LIMITS.subscriptionSync,
  );
  if (limited) return limited;

  const result = await syncSubscriptionWithBdapps(guard.userId);

  const messages: Record<typeof result.outcome, string> = {
    UPGRADED: "Your subscription is active. You are on Pro.",
    RENEWED: "Your subscription was renewed. You are on Pro.",
    DOWNGRADED:
      "Your subscription has ended, so your account moved to the Free plan.",
    ALREADY_CORRECT: `Your account is up to date on the ${result.planName} plan.`,
    NO_PHONE:
      "Add your mobile number to your profile so we can check your subscription.",
    GATEWAY_UNCLEAR:
      "We could not reach the subscription service. Please try again shortly.",
  };

  console.log("[subscription/sync]", {
    userId: guard.userId,
    outcome: result.outcome,
    plan: result.planName,
    detail: result.detail,
  });

  return NextResponse.json({
    ok: true,
    data: {
      outcome: result.outcome,
      plan_name: result.planName,
      message: messages[result.outcome],
      // Which source said what, e.g. "carrier=TIMEOUT bkashStore=reachable".
      // No secrets in it, and without it an unclear answer cannot be chased
      // down from outside the logs - which is how a working bridge and a
      // failing call looked identical.
      detail: result.detail ?? null,
    },
  });
}
