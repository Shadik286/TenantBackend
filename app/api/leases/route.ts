import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { notifyLeaseAssignment } from "@/lib/notifications";
import { blockIfOverLimit } from "@/lib/plans/over-limit";

export const runtime = "nodejs";

/**
 * Loads leases scoped to the caller's houses. We always filter by
 * `house: { owner_id: ownerId }` so a malicious caller can't enumerate
 * leases across tenants by passing arbitrary `houseId` / `tenantId`
 * query params.
 *
 * Query params:
 *   - houseId: filter to one house
 *   - tenantId: filter to one tenant
 */
export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const houseId = request.nextUrl.searchParams.get("houseId");
  const tenantId = request.nextUrl.searchParams.get("tenantId");

  // Cap at 500 so a runaway caller can't paginate the whole table.
  const take = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get("take")) || 500, 1),
    1000,
  );

  const leases = await prisma.lease.findMany({
    where: {
      house: {
        owner_id: ownerId,
        deleted_at: null,
        ...(houseId ? { id: houseId } : {}),
      },
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    orderBy: { created_at: "desc" },
    take,
    select: {
      id: true,
      house_id: true,
      unit_id: true,
      tenant_id: true,
      status: true,
      start_date: true,
      end_date: true,
      move_in_date: true,
      move_out_date: true,
      security_deposit: true,
      ended_reason: true,
      notes: true,
      created_at: true,
      updated_at: true,
    },
  });

  return NextResponse.json({ data: leases });
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  // A lapsed PRO account holding more than the free tier allows is
  // read-only (deletes aside) until it is trimmed back inside the caps.
  // See lib/plans/over-limit.ts.
  const overLimit = await blockIfOverLimit(ownerId);
  if (overLimit) return overLimit;

  const body = await request.json();
  const {
    houseId,
    unitId,
    tenantId,
    startDate,
    endDate,
    moveInDate,
    moveOutDate,
    securityDeposit,
    notes,
  } = body as {
    houseId?: string;
    unitId?: string;
    tenantId?: string;
    startDate?: string;
    endDate?: string | null;
    moveInDate?: string;
    moveOutDate?: string | null;
    securityDeposit?: number;
    notes?: string | null;
  };

  if (!houseId || !unitId || !tenantId || !startDate || !moveInDate) {
    return NextResponse.json(
      { error: "houseId, unitId, tenantId, startDate, and moveInDate are required." },
      { status: 400 }
    );
  }

  // Verify the house belongs to the caller — without this, any
  // authenticated user could attach a tenant they don't own to any
  // unit in any house.
  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
    select: { id: true },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }

  // Verify the unit is in this house.
  const unit = await prisma.unit.findFirst({
    where: { id: unitId, house_id: houseId, deleted_at: null },
    select: { id: true },
  });

  if (!unit) {
    return NextResponse.json(
      { error: "The requested unit was not found in the selected house." },
      { status: 404 }
    );
  }

  // Verify the tenant belongs to the caller — prevents cross-tenant
  // lease creation.
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, owner_id: ownerId, deleted_at: null },
    select: { id: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "TENANT_NOT_FOUND" }, { status: 404 });
  }

  const activeLease = await prisma.lease.findFirst({
    where: { unit_id: unitId, status: "ACTIVE" },
    select: { id: true },
  });

  if (activeLease) {
    return NextResponse.json(
      { error: "This unit already has an active lease." },
      { status: 409 }
    );
  }

  const lease = await prisma.lease.create({
    data: {
      house_id: houseId,
      unit_id: unitId,
      tenant_id: tenantId,
      start_date: new Date(startDate),
      end_date: endDate ? new Date(endDate) : null,
      move_in_date: new Date(moveInDate),
      move_out_date: moveOutDate ? new Date(moveOutDate) : null,
      security_deposit: securityDeposit ? securityDeposit : 0,
      notes: notes ?? null,
    },
    select: {
      id: true,
      house_id: true,
      unit_id: true,
      tenant_id: true,
      status: true,
      start_date: true,
      end_date: true,
      move_in_date: true,
      move_out_date: true,
      security_deposit: true,
      ended_reason: true,
      notes: true,
      created_at: true,
      updated_at: true,
    },
  });

  // Assignment notice — path 1 of 3. The other two live in
  // app/api/tenants/route.ts (tenant + lease created together during
  // onboarding) and app/api/tenants/[tenantId]/route.ts (re-assignment via
  // tenant edit). All three must stay wired, or most real assignments send
  // nothing: this direct route is actually the least-travelled of them.
  await notifyLeaseAssignment({
    landlordUserId: ownerId,
    leaseId: lease.id,
    houseId: lease.house_id,
    unitId: lease.unit_id,
    tenantId: lease.tenant_id,
    moveInDate: lease.move_in_date,
    securityDeposit: lease.security_deposit?.toFixed(2) ?? null,
  });

  return NextResponse.json({ data: lease }, { status: 201 });
}
