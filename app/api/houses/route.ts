import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const UNLIMITED_PLAN_MARKER = 2_147_483_647;

// Fetches the caller's active plan limits. Returns null if no subscription is
// attached (treat the account as FREE with the default 2-house limit).
// Runs the subscription lookup AND the FREE-plan fallback lookup in
// parallel so a missing subscription doesn't cost an extra round trip.
async function getPlanForOwner(ownerId: string) {
  const [subscription, freePlan] = await Promise.all([
    prisma.subscription.findUnique({
      where: { user_id: ownerId },
      include: { plan: true },
    }),
    prisma.plan.findUnique({ where: { name: "FREE" } }),
  ]);
  if (!subscription) {
    return freePlan
      ? { plan: freePlan, status: "ACTIVE" as const }
      : null;
  }
  return subscription;
}

export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const [houses, sub] = await Promise.all([
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

  const maxHouses = sub?.plan.max_houses ?? 2;
  const isUnlimited = maxHouses >= UNLIMITED_PLAN_MARKER;

  return NextResponse.json({
    data: houses,
    plan: {
      name: sub?.plan.name ?? "FREE",
      max_houses: isUnlimited ? null : maxHouses,
      is_unlimited: isUnlimited,
      used: houses.length,
      remaining: isUnlimited ? null : Math.max(0, maxHouses - houses.length),
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
  const [activeCount, sub] = await Promise.all([
    prisma.house.count({ where: { owner_id: ownerId, deleted_at: null } }),
    getPlanForOwner(ownerId),
  ]);

  const maxHouses = sub?.plan.max_houses ?? 2;
  const isUnlimited = maxHouses >= UNLIMITED_PLAN_MARKER;

  if (!isUnlimited && activeCount >= maxHouses) {
    return NextResponse.json(
      {
        error: "HOUSE_LIMIT_REACHED",
        message: `Your ${sub?.plan.name ?? "FREE"} plan allows up to ${maxHouses} active houses.`,
        limit: maxHouses,
        current: activeCount,
        plan: sub?.plan.name ?? "FREE",
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
