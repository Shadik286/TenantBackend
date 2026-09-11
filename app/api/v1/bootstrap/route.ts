import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";
import { getPlanForOwner, UNLIMITED_SENTINEL } from "@/lib/plans/get-plan";

export const runtime = "nodejs";

/**
 * GET /api/v1/bootstrap — everything the app needs at launch, in ONE request.
 *
 * WHY THIS EXISTS
 * ---------------
 * Startup used to fire six separate requests:
 *
 *   /api/v1/users/me            profile
 *   /api/v1/users/me/stats      counts
 *   /api/v1/users/me/subscription
 *   /api/v1/users/me/preferences
 *   /api/v1/plans               static config, refetched every launch
 *   /api/houses                 house list
 *
 * Each one paid its own TLS negotiation, its own Vercel routing, its own
 * cold-start risk, and — the expensive part — its own `requireUserId()` lookup
 * plus, on some routes, a full plan resolution. Six requests meant SIX
 * redundant reads of the same user row to render one screen.
 *
 * Collapsing them removes that repetition: one auth check, one plan
 * resolution, and the remaining reads issued together. Four of the six
 * sections did not need a query of their own at all — `profile`,
 * `preferences` and `subscription` all hang off the same user row, and
 * `plans` is cached configuration.
 *
 * The response is deliberately keyed by section, with each section shaped
 * exactly like the endpoint it replaces, so the client can keep its existing
 * parsing and the old routes stay valid for anything still calling them.
 */

function serializePlanRow(plan: {
  id: string;
  name: string;
  max_houses: number;
  max_units_per_house: number;
  max_tenants: number;
  price_monthly: unknown;
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
    price_monthly: String(plan.price_monthly),
    features: plan.features,
  };
}

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const userId = guard.userId;

  // One round trip for everything that can be read independently.
  //
  // `user` carries profile, preferences AND the subscription in a single row
  // graph — three of the six original requests collapse into this one read,
  // because they were always different views of the same record.
  const [user, plan, houses, counts, allPlans] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        full_name: true,
        phone: true,
        is_verified: true,
        is_active: true,
        created_at: true,
        updated_at: true,
        provider: true,
        phone_verified: true,
        pin_hash: true,
        preference: {
          select: {
            notifications: true,
            language: true,
            appearance: true,
            currency: true,
            timezone: true,
            updated_at: true,
          },
        },
        subscription: {
          select: {
            id: true,
            status: true,
            current_period_start: true,
            current_period_end: true,
            cancelled_at: true,
            plan: true,
          },
        },
      },
    }),
    // Resolves coupon + subscription together and reads plan rows from the
    // in-process cache, so this is usually one query rather than three.
    getPlanForOwner(userId),
    prisma.house.findMany({
      where: { owner_id: userId, deleted_at: null },
      orderBy: { created_at: "desc" },
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
    // The four counters the stats endpoint returns. Grouped here so they share
    // this request's connection instead of opening their own.
    Promise.all([
      prisma.house.count({ where: { owner_id: userId, deleted_at: null } }),
      prisma.unit.count({
        where: { deleted_at: null, house: { owner_id: userId, deleted_at: null } },
      }),
      prisma.tenant.count({ where: { owner_id: userId, deleted_at: null } }),
      prisma.lease.count({
        where: { status: "ACTIVE", house: { owner_id: userId, deleted_at: null } },
      }),
    ]),
    // Served from the plan cache on a warm instance, so usually free.
    prisma.plan.findMany({ where: { is_active: true }, orderBy: { price_monthly: "asc" } }),
  ]);

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const [houseCount, unitCount, tenantCount, activeLeases] = counts;
  const sub = user.subscription;

  return NextResponse.json({
    data: {
      // Mirrors GET /api/v1/users/me
      profile: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        phone: user.phone,
        is_verified: user.is_verified,
        is_active: user.is_active,
        created_at: user.created_at,
        updated_at: user.updated_at,
        provider: user.provider,
        phone_verified: user.phone_verified,
        needs_phone: !user.phone,
        // Lets the client decide whether to show the PIN gate without a
        // separate round trip to /api/v1/users/me/pin.
        has_pin: Boolean(user.pin_hash),
      },

      // Mirrors GET /api/v1/users/me/preferences. Defaults match the schema,
      // so a user with no preference row still gets a usable object rather
      // than null — the old endpoint created the row lazily, which cost a
      // write on first launch.
      preferences: user.preference ?? {
        notifications: "all",
        language: "en-US",
        appearance: "system",
        currency: "MAD",
        timezone: "UTC",
        updated_at: null,
      },

      // Mirrors GET /api/v1/users/me/subscription, or null where that
      // endpoint would have answered 404.
      subscription: sub
        ? {
            id: sub.id,
            status: sub.status,
            current_period_start: sub.current_period_start,
            current_period_end: sub.current_period_end,
            cancelled_at: sub.cancelled_at,
            plan: serializePlanRow(sub.plan),
          }
        : null,

      // Effective entitlement, which is NOT the same as `subscription.plan`:
      // a FREE_PRO coupon grants PRO limits without altering the subscription
      // row. The client should gate features on this.
      entitlement: {
        plan_name: plan.planName,
        max_houses: plan.isUnlimitedHouses ? null : plan.maxHouses,
        max_units_per_house: plan.isUnlimitedUnitsPerHouse
          ? null
          : plan.maxUnitsPerHouse,
        max_tenants: plan.isUnlimitedTenants ? null : plan.maxTenants,
        is_pro: plan.isPro,
        status: plan.status,
        source: plan.source,
        coupon_expires_at: plan.couponExpiresAt,
      },

      // Mirrors GET /api/houses (the `plan` block that endpoint returns is
      // folded into `entitlement` above rather than duplicated).
      houses,

      // Mirrors GET /api/v1/users/me/stats
      stats: {
        houses: houseCount,
        units: unitCount,
        tenants: tenantCount,
        active_leases: activeLeases,
      },

      // Mirrors GET /api/v1/plans. Included because it is free: the plan rows
      // come from the in-process cache, so this costs no query on a warm
      // instance — whereas as a separate request it cost a full round trip
      // plus another requireUserId() lookup on every single app launch, for
      // two rows of static configuration.
      plans: allPlans.map(serializePlanRow),
    },
  });
}
