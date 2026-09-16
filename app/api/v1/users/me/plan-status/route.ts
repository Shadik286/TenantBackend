import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { getPlanForOwner } from "@/lib/plans/get-plan";
import { getOverLimitState } from "@/lib/plans/over-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/v1/users/me/plan-status
// ---------------------------------------------------------------------------
//
// One call that answers "what may this user do right now".
//
// The client needs this on launch so a lapsed account can be shown the
// trim-down screen BEFORE they fill in a form, rather than discovering the
// block on submit. Everything here is already derivable from other endpoints;
// having it in one place is what makes the check cheap enough to run on every
// app open.
//
// {
//   plan: { name, is_pro, source, max_houses, max_units_per_house,
//           max_tenants, is_unlimited_* },
//   over_limit: { is_over_limit, resources: [{resource, current, limit, excess}] }
// }

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const plan = await getPlanForOwner(guard.userId);
  // Passed in so the state is computed against the plan we just resolved,
  // rather than resolving it a second time and risking two different answers
  // in one response.
  const overLimit = await getOverLimitState(guard.userId, plan);

  return NextResponse.json({
    ok: true,
    data: {
      plan: {
        name: plan.planName,
        is_pro: plan.isPro,
        status: plan.status,
        source: plan.source,
        max_houses: plan.isUnlimitedHouses ? null : plan.maxHouses,
        max_units_per_house: plan.isUnlimitedUnitsPerHouse
          ? null
          : plan.maxUnitsPerHouse,
        max_tenants: plan.isUnlimitedTenants ? null : plan.maxTenants,
        is_unlimited_houses: plan.isUnlimitedHouses,
        is_unlimited_units_per_house: plan.isUnlimitedUnitsPerHouse,
        is_unlimited_tenants: plan.isUnlimitedTenants,
        coupon_expires_at: plan.couponExpiresAt?.toISOString() ?? null,
      },
      over_limit: {
        is_over_limit: overLimit.isOverLimit,
        resources: overLimit.resources,
      },
    },
  });
}
