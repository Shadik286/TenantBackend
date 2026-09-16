// "You are over your plan limits" — what is over, and by how much.
//
// This exists because limits used to be enforced only at creation time. That
// is fine while a user only ever moves up a tier, but a PRO subscription that
// lapses drops someone from unlimited to 3 units and 3 tenants while they are
// already holding ten of each. Checking on create alone would leave them
// silently over the cap forever, still using everything they stopped paying
// for.
//
// So: a lapsed user keeps READ access and keeps the ability to DELETE, and is
// blocked from creating or updating until they are back inside the free tier.
// Deleting has to stay open — it is the only way out, and blocking it would
// trap them.
import { prisma } from "@/lib/prisma";
import { getPlanForOwner, type OwnerPlan } from "@/lib/plans/get-plan";

export type OverLimitResource = {
  resource: "houses" | "units" | "tenants";
  current: number;
  limit: number;
  /** How many must go before this resource is back inside the plan. */
  excess: number;
};

export type OverLimitState = {
  /** True when anything is over. */
  isOverLimit: boolean;
  planName: string;
  resources: OverLimitResource[];
};

/**
 * Work out whether an owner is over their current plan's caps.
 *
 * Units are counted ACROSS all houses rather than per house. The cap is
 * per-house, but "delete units until each house is under 3" is a rule a user
 * cannot act on from a single summary, so the worst offending house is what
 * gets reported.
 */
export async function getOverLimitState(
  ownerId: string,
  plan?: OwnerPlan,
): Promise<OverLimitState> {
  const resolved = plan ?? (await getPlanForOwner(ownerId));

  const [houseCount, tenantCount, houses] = await Promise.all([
    prisma.house.count({ where: { owner_id: ownerId, deleted_at: null } }),
    prisma.tenant.count({ where: { owner_id: ownerId, deleted_at: null } }),
    prisma.house.findMany({
      where: { owner_id: ownerId, deleted_at: null },
      select: {
        id: true,
        name: true,
        _count: { select: { units: { where: { deleted_at: null } } } },
      },
    }),
  ]);

  const over: OverLimitResource[] = [];

  if (!resolved.isUnlimitedHouses && houseCount > resolved.maxHouses) {
    over.push({
      resource: "houses",
      current: houseCount,
      limit: resolved.maxHouses,
      excess: houseCount - resolved.maxHouses,
    });
  }

  if (!resolved.isUnlimitedTenants && tenantCount > resolved.maxTenants) {
    over.push({
      resource: "tenants",
      current: tenantCount,
      limit: resolved.maxTenants,
      excess: tenantCount - resolved.maxTenants,
    });
  }

  if (!resolved.isUnlimitedUnitsPerHouse) {
    // Report the single worst house. Summing every house's excess would
    // overstate what the user has to do, and naming none of them would leave
    // them guessing which to open.
    let worstExcess = 0;
    let worstCount = 0;
    for (const house of houses) {
      const excess = house._count.units - resolved.maxUnitsPerHouse;
      if (excess > worstExcess) {
        worstExcess = excess;
        worstCount = house._count.units;
      }
    }
    if (worstExcess > 0) {
      over.push({
        resource: "units",
        current: worstCount,
        limit: resolved.maxUnitsPerHouse,
        excess: worstExcess,
      });
    }
  }

  return {
    isOverLimit: over.length > 0,
    planName: resolved.planName,
    resources: over,
  };
}

/**
 * A ready-made 403 for a write blocked by an over-limit account.
 *
 * Returns null when the write may proceed, so call sites read:
 *
 *   const blocked = await blockIfOverLimit(ownerId);
 *   if (blocked) return blocked;
 */
export async function blockIfOverLimit(ownerId: string) {
  const state = await getOverLimitState(ownerId);
  if (!state.isOverLimit) return null;

  const { NextResponse } = await import("next/server");

  const parts = state.resources.map(
    (r) => `${r.excess} ${r.excess === 1 ? singular(r.resource) : r.resource}`,
  );

  return NextResponse.json(
    {
      error: "OVER_PLAN_LIMIT",
      code: "OVER_PLAN_LIMIT",
      message:
        `Your ${state.planName} plan allows fewer records than you have. ` +
        `Remove ${parts.join(" and ")} to continue, or upgrade to PRO.`,
      details: {
        plan_name: state.planName,
        resources: state.resources,
      },
    },
    { status: 403 },
  );
}

function singular(resource: OverLimitResource["resource"]): string {
  if (resource === "houses") return "house";
  if (resource === "units") return "unit";
  return "tenant";
}
