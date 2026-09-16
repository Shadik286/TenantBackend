import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const UNLIMITED_SENTINEL = 2_147_483_647; // Int32.MAX

/**
 * In-process cache of the Plan rows.
 *
 * WHY: every route that checks a limit called getPlanForOwner(), which fetched
 * the FREE row — and sometimes the PRO row — on every single request. Against
 * Supabase's pooler each query costs ~260ms REGARDLESS of region (measured: a
 * bare `SELECT 1` on an already-open connection takes 261ms on the transaction
 * pooler and 279ms on the session pooler). So these lookups were ~500ms of
 * every response, for two rows that change approximately never.
 *
 * Plans are configuration, not user data: two rows, edited by hand or by
 * `npm run db:seed`. A stale read for at most 5 minutes is harmless — the
 * worst case is a limit change taking five minutes to take effect — whereas
 * re-reading them per request is the single largest avoidable cost in the API.
 *
 * Scope is one lambda instance, so it warms per instance and dies with it.
 * No invalidation needed beyond the TTL; if a plan edit must apply instantly,
 * redeploy.
 */
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

let planCache: { plans: Map<string, Plan>; expiresAt: number } | null = null;

async function loadPlans(): Promise<Map<string, Plan>> {
  const now = Date.now();
  if (planCache && planCache.expiresAt > now) return planCache.plans;

  // One query for every active plan, instead of one per name per request.
  const rows = await prisma.plan.findMany({ where: { is_active: true } });
  const plans = new Map(rows.map((p) => [p.name, p]));
  planCache = { plans, expiresAt: now + PLAN_CACHE_TTL_MS };
  return plans;
}

/** Cached lookup by plan name ("FREE" / "PRO"). */
async function planByName(name: string): Promise<Plan | null> {
  return (await loadPlans()).get(name) ?? null;
}

/** Drop the cache — for tests, or after editing plan rows in the same process. */
export function invalidatePlanCache(): void {
  planCache = null;
}

export type OwnerPlan = {
  planName: string;
  planId: string;
  maxHouses: number;
  maxUnitsPerHouse: number;
  maxTenants: number;
  trialDays: number;
  isUnlimitedHouses: boolean;
  isUnlimitedUnitsPerHouse: boolean;
  isUnlimitedTenants: boolean;
  isPro: boolean;
  status: string;
  /** Where these limits came from. */
  source: PlanSource;
  /** When a coupon-granted entitlement lapses. Null unless `source` is
   *  "coupon". */
  couponExpiresAt: Date | null;
};

export type PlanSource = "coupon" | "subscription" | "default";

/**
 * A live FREE_PRO coupon grant, or null.
 *
 * TRIAL_EXTENSION coupons are deliberately not here: those move the
 * subscription's own period end, so they are already reflected by the normal
 * subscription lookup and would double-count if read again.
 */
export async function activeCouponEntitlement(
  userId: string,
): Promise<{ expiresAt: Date } | null> {
  const redemption = await prisma.couponRedemption.findFirst({
    where: {
      user_id: userId,
      expires_at: { gt: new Date() },
      coupon: { type: "FREE_PRO" },
    },
    orderBy: { expires_at: "desc" },
    select: { expires_at: true },
  });
  return redemption ? { expiresAt: redemption.expires_at } : null;
}

/**
 * Resolve the active plan for an owner, in priority order:
 *
 *   1. A live FREE_PRO coupon. Beats everything, including a bdapps
 *      subscription check — the point of handing someone a free-PRO code is
 *      that they get PRO without paying anyone, so making it conditional on
 *      the carrier gateway would defeat it.
 *   2. Their Subscription row.
 *   3. The FREE plan, when there is no subscription yet (registration did not
 *      finish) or it is broken.
 */
export async function getPlanForOwner(ownerId: string): Promise<OwnerPlan> {
  // The two user-specific lookups are independent of each other, so they go in
  // parallel rather than one after the other. The plan rows come from the
  // in-process cache and usually cost no query at all.
  //
  // Before: coupon -> subscription -> FREE plan, strictly sequential, roughly
  // 780ms at ~260ms per query. After: one round trip, plus a cache hit.
  const [coupon, subscription, plans] = await Promise.all([
    activeCouponEntitlement(ownerId),
    prisma.subscription.findFirst({
      where: { user_id: ownerId },
      orderBy: { created_at: "desc" },
      include: { plan: true },
    }),
    loadPlans(),
  ]);

  if (coupon) {
    const proPlan = plans.get("PRO") ?? null;
    if (proPlan) {
      return {
        planName: proPlan.name,
        planId: proPlan.id,
        maxHouses: proPlan.max_houses,
        maxUnitsPerHouse: proPlan.max_units_per_house,
        maxTenants: proPlan.max_tenants,
        trialDays: proPlan.trial_days,
        isUnlimitedHouses: proPlan.max_houses >= UNLIMITED_SENTINEL,
        isUnlimitedUnitsPerHouse:
          proPlan.max_units_per_house >= UNLIMITED_SENTINEL,
        isUnlimitedTenants: proPlan.max_tenants >= UNLIMITED_SENTINEL,
        isPro: true,
        status: "ACTIVE",
        source: "coupon",
        couponExpiresAt: coupon.expiresAt,
      };
    }
    // No PRO row to grant. Fall through to the normal path rather than
    // throwing: a misconfigured plan table should downgrade the user, not
    // break every request they make.
  }

  // Both already resolved above — no further queries on this path.
  const freePlan = plans.get("FREE") ?? null;

  if (!subscription || !subscription.plan) {
    if (!freePlan) {
      throw new Error("FREE plan not found in database. Run `npm run db:seed`.");
    }
    return {
      planName: "FREE",
      planId: freePlan.id,
      maxHouses: freePlan.max_houses,
      maxUnitsPerHouse: freePlan.max_units_per_house,
      maxTenants: freePlan.max_tenants,
      trialDays: freePlan.trial_days,
      isUnlimitedHouses: freePlan.max_houses >= UNLIMITED_SENTINEL,
      isUnlimitedUnitsPerHouse: freePlan.max_units_per_house >= UNLIMITED_SENTINEL,
      isUnlimitedTenants: freePlan.max_tenants >= UNLIMITED_SENTINEL,
      isPro: false,
      status: "ACTIVE",
      source: "default",
      couponExpiresAt: null,
    };
  }

  const plan = subscription.plan;

  // A lapsed paid plan falls back to FREE limits.
  //
  // `current_period_end` was written by every signup and renewal but read by
  // nothing, so a PRO subscription kept PRO limits forever once granted —
  // whether or not the user ever paid again.
  //
  // FREE is explicitly exempt: it has no period worth honouring, and the free
  // tier is lifetime. 3 properties-worth of limits, for as long as they want,
  // with no trial clock. Expiring it would be the opposite of the intent.
  const expired =
    plan.name !== "FREE" &&
    subscription.current_period_end.getTime() < Date.now();

  if (expired && freePlan) {
    return {
      planName: freePlan.name,
      planId: freePlan.id,
      maxHouses: freePlan.max_houses,
      maxUnitsPerHouse: freePlan.max_units_per_house,
      maxTenants: freePlan.max_tenants,
      trialDays: freePlan.trial_days,
      isUnlimitedHouses: freePlan.max_houses >= UNLIMITED_SENTINEL,
      isUnlimitedUnitsPerHouse:
        freePlan.max_units_per_house >= UNLIMITED_SENTINEL,
      isUnlimitedTenants: freePlan.max_tenants >= UNLIMITED_SENTINEL,
      isPro: false,
      status: "EXPIRED",
      source: "default",
      couponExpiresAt: null,
    };
  }

  return {
    planName: plan.name,
    planId: plan.id,
    maxHouses: plan.max_houses,
    maxUnitsPerHouse: plan.max_units_per_house,
    maxTenants: plan.max_tenants,
    trialDays: plan.trial_days,
    isUnlimitedHouses: plan.max_houses >= UNLIMITED_SENTINEL,
    isUnlimitedUnitsPerHouse: plan.max_units_per_house >= UNLIMITED_SENTINEL,
    isUnlimitedTenants: plan.max_tenants >= UNLIMITED_SENTINEL,
    isPro: plan.name === "PRO",
    status: subscription.status,
    source: "subscription",
    couponExpiresAt: null,
  };
}

export async function getDefaultFreePlanId(): Promise<string> {
  // Cached: this runs on the registration path, where it used to add a full
  // query for a row that is already in memory on any warm instance.
  const freePlan = await planByName("FREE");
  if (!freePlan) {
    throw new Error("FREE plan not found in database. Run `npm run db:seed`.");
  }
  return freePlan.id;
}