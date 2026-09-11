import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { notifyLeaseAssignment } from "@/lib/notifications";
import { getPlanForOwner } from "@/lib/plans/get-plan";

export const runtime = "nodejs";

/**
 * Serializes a Tenant row along with its most recent lease and the unit
 * the lease is attached to. Returns `null` for `active_lease` when the
 * tenant has no lease (defensive — schema permits it).
 *
 * `leaseStatus` / `unitName` / `unitId` / `houseId` are flattened onto the
 * row so the Flutter list can render without an extra join per card.
 */
function serializeTenant(t: any) {
  const lease = (t.leases ?? [])[0] ?? null;
  const familyMembers = (t.family_members ?? []).map((m: any) => ({
    id: m.id,
    name: m.name,
    relation: m.relation,
  }));
  return {
    id: t.id,
    full_name: t.full_name,
    email: t.email ?? null,
    phone: t.phone ?? null,
    photo_url: t.photo_url ?? null,
    nid_image_url: t.nid_image_url ?? null,
    id_type: t.id_type ?? null,
    id_number: t.id_number ?? null,
    date_of_birth: t.date_of_birth ?? null,
    notes: t.notes ?? null,
    family_members: familyMembers,
    created_at: t.created_at,
    updated_at: t.updated_at,
    lease_status: lease?.status ?? null,
    lease_start_date: lease?.start_date ?? null,
    lease_end_date: lease?.end_date ?? null,
    lease_move_in_date: lease?.move_in_date ?? null,
    lease_move_out_date: lease?.move_out_date ?? null,
    security_deposit: lease?.security_deposit ?? null,
    unit_id: lease?.unit_id ?? null,
    unit_name: lease?.unit?.name ?? null,
    house_id: lease?.house_id ?? null,
    active_lease: lease
      ? {
          id: lease.id,
          status: lease.status,
          start_date: lease.start_date,
          end_date: lease.end_date,
          move_in_date: lease.move_in_date,
          move_out_date: lease.move_out_date,
          security_deposit: lease.security_deposit,
          unit_id: lease.unit_id,
          unit_name: lease.unit?.name ?? null,
          house_id: lease.house_id,
        }
      : null,
  };
}

export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const houseId = request.nextUrl.searchParams.get("houseId");

  // Cap the list at 200 rows so a runaway account can't slow the page to
  // a crawl by paginating the whole database. The Flutter UI shows at
  // most a few dozen at a time; 200 is a generous safety net. Clients
  // that need pagination should add `take`/`skip` later.
  const take = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get("take")) || 200, 1),
    500,
  );

  const tenants = await prisma.tenant.findMany({
    where: {
      owner_id: ownerId,
      // Soft-deleted tenants are gone as far as every caller is concerned.
      // DELETE /api/tenants/[tenantId] only stamps `deleted_at`, and without
      // this filter they kept showing up in the list — and would have
      // disagreed with the `plan.used` count below, which excludes them.
      deleted_at: null,
      ...(houseId
        ? {
            leases: {
              some: { house_id: houseId },
            },
          }
        : {}),
    },
    orderBy: { created_at: "desc" },
    take,
    // Explicit `select` instead of `include` so Prisma only ships the
    // columns Flutter actually uses. We skip the `description` blob
    // (rarely used on list screens) and the soft-delete bookkeeping
    // columns; everything else the list needs is here.
    select: {
      id: true,
      full_name: true,
      email: true,
      phone: true,
      notes: true,
      photo_url: true,
      nid_image_url: true,
      id_type: true,
      id_number: true,
      date_of_birth: true,
      created_at: true,
      updated_at: true,
      leases: {
        orderBy: { created_at: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          start_date: true,
          end_date: true,
          move_in_date: true,
          move_out_date: true,
          security_deposit: true,
          unit_id: true,
          house_id: true,
          unit: { select: { id: true, name: true } },
        },
      },
      family_members: {
        orderBy: { created_at: "asc" },
        select: { id: true, name: true, relation: true },
      },
    },
  });

  // Plan block mirrors GET /api/houses so the client can render "2 of 3
  // used" and pre-disable Add Tenant without waiting for a 403. Counted
  // separately from `tenants` above because that list can be narrowed by
  // `houseId`, while the cap spans every house the owner has.
  const [plan, activeTenantCount] = await Promise.all([
    getPlanForOwner(ownerId),
    prisma.tenant.count({ where: { owner_id: ownerId, deleted_at: null } }),
  ]);

  return NextResponse.json({
    data: tenants.map(serializeTenant),
    plan: {
      name: plan.planName,
      max_tenants: plan.isUnlimitedTenants ? null : plan.maxTenants,
      is_unlimited: plan.isUnlimitedTenants,
      used: activeTenantCount,
      remaining: plan.isUnlimitedTenants
        ? null
        : Math.max(0, plan.maxTenants - activeTenantCount),
    },
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const body = await request.json();
  const {
    fullName,
    full_name,
    email,
    phone,
    notes,
    idType,
    id_number,
    photoUrl,
    photo_url,
    nidImageUrl,
    nid_image_url,
    unitId,
    unit_id,
    houseId,
    house_id,
    startDate,
    start_date,
    endDate,
    end_date,
    moveInDate,
    move_in_date,
    securityDeposit,
    security_deposit,
    familyMembers,
    family_members,
    dateOfBirth,
    date_of_birth,
  } = body as Record<string, any>;

  const tenantName = fullName ?? full_name;
  const resolvedUnitId = unitId ?? unit_id;
  const resolvedHouseId = houseId ?? house_id;
  const resolvedStart = startDate ?? start_date;
  const resolvedMoveIn = moveInDate ?? move_in_date;
  const resolvedEnd = endDate ?? end_date;
  const resolvedDeposit = securityDeposit ?? security_deposit ?? 0;
  const resolvedPhotoUrl = photoUrl ?? photo_url;
  const resolvedNidUrl = nidImageUrl ?? nid_image_url;
  const resolvedDob = dateOfBirth ?? date_of_birth;
  const rawFamilyMembers = familyMembers ?? family_members ?? [];

  if (!tenantName) {
    return NextResponse.json(
      { error: "fullName is required." },
      { status: 400 },
    );
  }

  // Plan-limit check before the insert. Unlike units, which are capped per
  // house, this counts every active tenant the owner has across all houses —
  // otherwise a FREE owner could sidestep the cap by spreading tenants out.
  // Soft-deleted tenants don't count, matching houses and units.
  //
  // This runs before the transaction rather than inside it: an owner racing
  // two creates could squeeze past by one, which is the same benign race the
  // house and unit checks accept. Serialising it would cost a held
  // connection on every tenant create to prevent an off-by-one in a limit
  // the user can lift by upgrading.
  const [plan, activeTenantCount] = await Promise.all([
    getPlanForOwner(ownerId),
    prisma.tenant.count({ where: { owner_id: ownerId, deleted_at: null } }),
  ]);

  if (!plan.isUnlimitedTenants && activeTenantCount >= plan.maxTenants) {
    return NextResponse.json(
      {
        error: "TENANT_LIMIT_REACHED",
        code: "TENANT_LIMIT_REACHED",
        message:
          `Your ${plan.planName} plan allows up to ${plan.maxTenants} tenants. ` +
          `Upgrade to PRO for unlimited tenants.`,
        details: {
          plan_name: plan.planName,
          max_tenants: plan.maxTenants,
          current_active_tenants: activeTenantCount,
          upgrade_url: "/billing/upgrade",
        },
      },
      { status: 403 },
    );
  }

  // Combined onboarding: tenant + lease in a single transaction so a tenant
  // can never exist in a "half-onboarded" state with no lease. The Flutter
  // Add-Tenant form sends unitId/houseId/startDate/moveInDate together.
  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        owner_id: ownerId,
        full_name: tenantName,
        email: email ?? null,
        phone: phone ?? null,
        notes: notes ?? null,
        photo_url: resolvedPhotoUrl ?? null,
        nid_image_url: resolvedNidUrl ?? null,
        id_type: idType ?? null,
        id_number: id_number ?? null,
        date_of_birth: resolvedDob ? new Date(resolvedDob) : null,
      },
    });

    // Persist family members (if any) in the same transaction. Empty rows
    // are filtered out — rows without a name would otherwise violate the
    // schema and be useless in the UI.
    const cleanedFamily = Array.isArray(rawFamilyMembers)
      ? rawFamilyMembers.filter((m: any) => {
          if (!m || typeof m !== "object") return false;
          const name = (m.name ?? "").toString().trim();
          return name.length > 0;
        })
      : [];
    if (cleanedFamily.length > 0) {
      await tx.tenantFamilyMember.createMany({
        data: cleanedFamily.map((m: any) => {
          const name = m.name.toString().trim();
          const relation = (m.relation ?? "").toString().trim();
          return {
            tenant_id: tenant.id,
            name,
            relation: relation.length > 0 ? relation : "—",
          };
        }),
      });
    }

    if (resolvedUnitId && resolvedHouseId && resolvedMoveIn) {
      // Verify the unit belongs to a house owned by this user.
      const unit = await tx.unit.findFirst({
        where: { id: resolvedUnitId, house_id: resolvedHouseId },
      });
      if (!unit) {
        throw new Error("UNIT_NOT_FOUND");
      }

      // Refuse if the unit already has an active lease.
      const existing = await tx.lease.findFirst({
        where: { unit_id: resolvedUnitId, status: "ACTIVE" },
      });
      if (existing) {
        throw new Error("UNIT_ALREADY_OCCUPIED");
      }

      await tx.lease.create({
        data: {
          house_id: resolvedHouseId,
          unit_id: resolvedUnitId,
          tenant_id: tenant.id,
          status: "ACTIVE",
          start_date: new Date(resolvedStart ?? resolvedMoveIn),
          end_date: resolvedEnd ? new Date(resolvedEnd) : null,
          move_in_date: new Date(resolvedMoveIn),
          security_deposit: resolvedDeposit,
        },
      });
    }

    // Return the tenant + its (now newest) lease for the response.
    return tx.tenant.findUnique({
      where: { id: tenant.id },
      include: {
        leases: {
          orderBy: { created_at: "desc" },
          take: 1,
          include: { unit: true },
        },
        family_members: { orderBy: { created_at: "asc" } },
      },
    });
  });

  // Assignment notice — path 2 of 3, and the busiest: onboarding creates the
  // tenant and their lease in one call. Fires only when a lease was actually
  // created, since this route also serves tenants added without a unit.
  //
  // Sent AFTER the transaction commits, deliberately. Notifying from inside
  // would mail the tenant even if the transaction later rolled back.
  const newLease = result?.leases?.[0];
  if (newLease) {
    await notifyLeaseAssignment({
      landlordUserId: ownerId,
      leaseId: newLease.id,
      houseId: newLease.house_id,
      unitId: newLease.unit_id,
      tenantId: result.id,
      moveInDate: newLease.move_in_date,
      securityDeposit: newLease.security_deposit?.toFixed(2) ?? null,
    });
  }

  return NextResponse.json({ data: serializeTenant(result) }, { status: 201 });
}
