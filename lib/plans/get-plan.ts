import { prisma } from "@/lib/prisma";

export const UNLIMITED_SENTINEL = 2_147_483_647; // Int32.MAX

export type OwnerPlan = {
  planName: string;
  planId: string;
  maxHouses: number;
  maxUnitsPerHouse: number;
  isUnlimitedHouses: boolean;
  isUnlimitedUnitsPerHouse: boolean;
  isPro: boolean;
  status: string;
};

/**
 * Resolve the active plan for an owner. Falls back to the FREE plan if the
 * user has no subscription row yet (registration hasn't completed) or if their
 * subscription is missing — same as a FREE-tier user for limit checks.
 */
export async function getPlanForOwner(ownerId: string): Promise<OwnerPlan> {
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
      isUnlimitedHouses: freePlan.max_houses >= UNLIMITED_SENTINEL,
      isUnlimitedUnitsPerHouse: freePlan.max_units_per_house >= UNLIMITED_SENTINEL,
      isPro: false,
      status: "ACTIVE",
    };
  }

  const plan = subscription.plan;
  return {
    planName: plan.name,
    planId: plan.id,
    maxHouses: plan.max_houses,
    maxUnitsPerHouse: plan.max_units_per_house,
    isUnlimitedHouses: plan.max_houses >= UNLIMITED_SENTINEL,
    isUnlimitedUnitsPerHouse: plan.max_units_per_house >= UNLIMITED_SENTINEL,
    isPro: plan.name === "PRO",
    status: subscription.status,
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