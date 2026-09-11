import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { getPlanForOwner } from "@/lib/plans/get-plan";

export const runtime = "nodejs";

// The plan lookup lives in `lib/plans/get-plan.ts` and is shared with the
// units and tenants routes. This file used to carry its own copy that
// defaulted a missing FREE plan to 2 houses; the shared helper throws
// instead, so a database that was never seeded fails loudly rather than
// silently handing every user a limit nobody configured.

export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const [houses, plan] = await Promise.all([
    prisma.house.findMany({
      where: { owner_id: ownerId, deleted_at: null },
      orderBy: { created_at: "desc" },
      // Explicit `select` so we don't ship the (often-empty) `description`
      // blob and the soft-delete bookkeeping column over the wire.
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        country: true,
        description: true,
        created_at: true,
        updated_at: true,
      },
    }),
    getPlanForOwner(ownerId),
  ]);

  const isUnlimited = plan.isUnlimitedHouses;

  return NextResponse.json({
    data: houses,
    plan: {
      name: plan.planName,
      max_houses: isUnlimited ? null : plan.maxHouses,
      is_unlimited: isUnlimited,
      used: houses.length,
      remaining: isUnlimited
        ? null
        : Math.max(0, plan.maxHouses - houses.length),
    },
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const body = await request.json();
  const { name, address, city, country, description } = body as {
    name?: string;
    address?: string;
    city?: string;
    country?: string;
    description?: string | null;
  };

  // Only `name` is required. The rest are optional and default to empty
  // strings so the row can still be created from a mobile "quick add"
  // where the user may not have all the location details yet.
  if (!name || !name.trim()) {
    return NextResponse.json(
      { error: "Property name is required." },
      { status: 400 }
    );
  }
  const safeName = name.trim();
  const safeAddress = (address ?? "").trim();
  const safeCity = (city ?? "").trim();
  const safeCountry = (country ?? "").trim();

  // Plan-limit check before insert. Soft-deleted houses do NOT count against
  // the limit, matching the architecture's free-tier rule.
  const [activeCount, plan] = await Promise.all([
    prisma.house.count({ where: { owner_id: ownerId, deleted_at: null } }),
    getPlanForOwner(ownerId),
  ]);

  if (!plan.isUnlimitedHouses && activeCount >= plan.maxHouses) {
    return NextResponse.json(
      {
        error: "HOUSE_LIMIT_REACHED",
        code: "HOUSE_LIMIT_REACHED",
        message:
          `Your ${plan.planName} plan allows up to ${plan.maxHouses} active ` +
          `${plan.maxHouses === 1 ? "house" : "houses"}. ` +
          `Upgrade to PRO for unlimited houses.`,
        limit: plan.maxHouses,
        current: activeCount,
        plan: plan.planName,
        details: {
          plan_name: plan.planName,
          max_houses: plan.maxHouses,
          current_active_houses: activeCount,
          upgrade_url: "/billing/upgrade",
        },
      },
      { status: 403 }
    );
  }

  const house = await prisma.house.create({
    data: {
      owner_id: ownerId,
      name: safeName,
      address: safeAddress,
      city: safeCity,
      country: safeCountry,
      description: description ?? null,
    },
  });

  return NextResponse.json({ data: house }, { status: 201 });
}
