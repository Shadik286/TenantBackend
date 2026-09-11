import { prisma } from "@/lib/prisma";

export const UNLIMITED_SENTINEL = 2_147_483_647; // Int32.MAX

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
  const coupon = await activeCouponEntitlement(ownerId);
  if (coupon) {
    const proPlan = await prisma.plan.findFirst({
      where: { name: "PRO", is_active: true },
    });
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

  const subscription = await prisma.subscription.findFirst({
    where: { user_id: ownerId },
    orderBy: { created_at: "desc" },
    include: { plan: true },
  });

  // Try to find a FREE plan if no subscription OR subscription is broken
  const freePlan = await prisma.plan.findFirst({
    where: { name: "FREE", is_active: true },
  });

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
  const freePlan = await prisma.plan.findFirst({
    where: { name: "FREE", is_active: true },
  });
  if (!freePlan) {
    throw new Error("FREE plan not found in database. Run `npm run db:seed`.");
  }
  return freePlan.id;
}