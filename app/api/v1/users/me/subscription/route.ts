import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";
import { UNLIMITED_SENTINEL } from "@/lib/plans/get-plan";

export const runtime = "nodejs";

/** Shape a `Plan` row for client consumption. */
function serializePlan(plan: {
  id: string;
  name: string;
  max_houses: number;
  max_units_per_house: number;
  max_tenants: number;
  trial_days: number;
  price_monthly: { toString(): string };
  features: unknown;
}) {
  const unlimitedHouses = plan.max_houses >= UNLIMITED_SENTINEL;
  const unlimitedUnits = plan.max_units_per_house >= UNLIMITED_SENTINEL;
  const unlimitedTenants = plan.max_tenants >= UNLIMITED_SENTINEL;
  return {
    id: plan.id,
    name: plan.name,
    max_houses: unlimitedHouses ? null : plan.max_houses,
    is_unlimited_houses: unlimitedHouses,
    max_units_per_house: unlimitedUnits ? null : plan.max_units_per_house,
    is_unlimited_units_per_house: unlimitedUnits,
    max_tenants: unlimitedTenants ? null : plan.max_tenants,
    is_unlimited_tenants: unlimitedTenants,
    trial_days: plan.trial_days,
    price_monthly: plan.price_monthly.toString(),
    features: plan.features,
  };
}

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const sub = await prisma.subscription.findUnique({
    where: { user_id: guard.userId },
    include: {
      plan: {
        select: {
          id: true,
          name: true,
          max_houses: true,
          max_units_per_house: true,
          max_tenants: true,
          trial_days: true,
          price_monthly: true,
          features: true,
        },
      },
    },
  });

  if (!sub) {
    return NextResponse.json(
      { error: "No subscription for this user." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    data: {
      id: sub.id,
      status: sub.status,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      cancelled_at: sub.cancelled_at,
      plan: serializePlan(sub.plan),
    },
  });
}

/**
 * Switch the authenticated user's subscription to the named plan.
 *
 * DOWNGRADES ONLY. This handler used to set any plan the caller named, which
 * meant one authenticated request -
 *
 *     PATCH /api/v1/users/me/subscription  {"plan_name":"PRO"}
 *
 * - granted unlimited PRO with no payment and without bdApps being asked at
 * all. The bdapps login screen was doing exactly that on every sign-in, so an
 * account came back PRO whether or not the payment gateway was completed, and
 * cancelling at the gateway changed nothing.
 *
 * A paid plan may now only be set by a path that has confirmation behind it:
 *
 *   app/api/subscription/return   bdApps said REGISTERED after the gateway
 *   lib/plans/sync.ts             bdApps says REGISTERED now (poll or cron)
 *   app/api/v1/coupons/redeem     a coupon we issued
 *
 * Downgrading to a free plan stays open: nobody should have to visit a
 * payment page to stop paying.
 */
export async function PATCH(request: Request) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const body = (await request.json().catch(() => null)) as {
    plan_name?: unknown;
    plan_id?: unknown;
  } | null;

  let planId: string | null = null;
  if (typeof body?.plan_id === "string") planId = body.plan_id;
  if (typeof body?.plan_name === "string") {
    const plan = await prisma.plan.findFirst({
      where: { name: body.plan_name.toUpperCase(), is_active: true },
    });
    if (!plan) {
      return NextResponse.json(
        { error: `Plan "${body.plan_name}" not found or not active.` },
        { status: 404 }
      );
    }
    planId = plan.id;
  }
  if (!planId) {
    return NextResponse.json(
      { error: "Provide `plan_name` (e.g. FREE/PRO) or `plan_id`." },
      { status: 400 }
    );
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.is_active) {
    return NextResponse.json(
      { error: "Plan is not available." },
      { status: 404 }
    );
  }

  // The entitlement gate. `price_monthly` rather than a name check, so a new
  // paid tier added later is closed by default instead of being forgotten.
  if (plan.price_monthly.greaterThan(0)) {
    return NextResponse.json(
      {
        error: "PLAN_REQUIRES_PAYMENT",
        code: "PLAN_REQUIRES_PAYMENT",
        message:
          `The ${plan.name} plan is activated by subscribing, not by asking. ` +
          "Start the subscription from the app and it becomes active once " +
          "bdApps confirms the payment.",
      },
      { status: 403 },
    );
  }

  const now = new Date();
  const oneMonthLater = new Date(now);
  oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);

  const sub = await prisma.subscription.upsert({
    where: { user_id: guard.userId },
    update: {
      plan_id: plan.id,
      status: "ACTIVE",
      cancelled_at: null,
      current_period_start: now,
      current_period_end: oneMonthLater,
    },
    create: {
      user_id: guard.userId,
      plan_id: plan.id,
      status: "ACTIVE",
      current_period_start: now,
      current_period_end: oneMonthLater,
    },
    include: {
      plan: {
        select: {
          id: true,
          name: true,
          max_houses: true,
          max_units_per_house: true,
          max_tenants: true,
          trial_days: true,
          price_monthly: true,
          features: true,
        },
      },
    },
  });

  return NextResponse.json({
    data: {
      id: sub.id,
      status: sub.status,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      cancelled_at: sub.cancelled_at,
      plan: serializePlan(sub.plan),
    },
  });
}