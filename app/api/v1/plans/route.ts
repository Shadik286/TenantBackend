import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";
import { UNLIMITED_SENTINEL } from "@/lib/plans/get-plan";

export const runtime = "nodejs";

/**
 * List every active plan. The Flutter "Manage Subscription" sheet uses this
 * to render Free vs Pro (and any future tiers) dynamically instead of
 * hard-coding them in the UI.
 */
export async function GET() {
  // Requires auth so we don't expose plan pricing to anonymous scrapers.
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const plans = await prisma.plan.findMany({
    where: { is_active: true },
    orderBy: { price_monthly: "asc" },
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
  });

  return NextResponse.json({
    data: plans.map((plan) => {
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
    }),
  });
}