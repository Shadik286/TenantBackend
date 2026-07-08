import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

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
    date_of_birth: t.date_of_birth ?? null,
    id_type: t.id_type ?? null,
    id_number: t.id_number ?? null,
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

async function loadOwnedTenant(tenantId: string, ownerId: string) {
  return prisma.tenant.findFirst({
    where: { id: tenantId, owner_id: ownerId },
    include: {
      leases: {
        orderBy: { created_at: "desc" },
        take: 1,
        include: { unit: true },
      },
      family_members: { orderBy: { created_at: "asc" } },
    },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { tenantId } = await context.params;

  const tenant = await loadOwnedTenant(tenantId, ownerId);
  if (!tenant) {
    return NextResponse.json({ error: "TENANT_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ data: serializeTenant(tenant) });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { tenantId } = await context.params;

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
    // Lease edit fields (optional — only updated if provided).
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
    leaseStatus,
    lease_status,
    // Family members: when provided, replaces ALL existing members with the
    // supplied list (cascades deletions via the FK). Each entry must be an
    // object with `name` and `relation`. Omit the field to leave them alone.
    family_members,
    familyMembers,
    dateOfBirth,
    date_of_birth,
  } = body as Record<string, any>;

  const tenant = await loadOwnedTenant(tenantId, ownerId);
  if (!tenant) {
    return NextResponse.json({ error: "TENANT_NOT_FOUND" }, { status: 404 });
  }

  // Build patch payloads only from fields actually supplied.
  const tenantPatch: Record<string, any> = {};
  const resolvedName = fullName ?? full_name;
  if (resolvedName !== undefined) tenantPatch.full_name = resolvedName;
  if (email !== undefined) tenantPatch.email = email ?? null;
  if (phone !== undefined) tenantPatch.phone = phone ?? null;
  if (notes !== undefined) tenantPatch.notes = notes ?? null;
  if (idType !== undefined) tenantPatch.id_type = idType ?? null;
  if (id_number !== undefined) tenantPatch.id_number = id_number ?? null;
  const resolvedPhotoUrl = photoUrl ?? photo_url;
  if (resolvedPhotoUrl !== undefined) tenantPatch.photo_url = resolvedPhotoUrl ?? null;
  const resolvedNidUrl = nidImageUrl ?? nid_image_url;
  if (resolvedNidUrl !== undefined) tenantPatch.nid_image_url = resolvedNidUrl ?? null;
  const resolvedDob = dateOfBirth ?? date_of_birth;
  if (resolvedDob !== undefined) {
    tenantPatch.date_of_birth = resolvedDob ? new Date(resolvedDob) : null;
  }

  const resolvedUnitId = unitId ?? unit_id;
  const resolvedHouseId = houseId ?? house_id;
  const resolvedStart = startDate ?? start_date;
  const resolvedMoveIn = moveInDate ?? move_in_date;
  const resolvedEnd = endDate ?? end_date;
  const resolvedDeposit = securityDeposit ?? security_deposit;
  const resolvedStatus = leaseStatus ?? lease_status;

  const leasePatch: Record<string, any> = {};
  if (resolvedStart !== undefined) leasePatch.start_date = new Date(resolvedStart);
  if (resolvedMoveIn !== undefined) leasePatch.move_in_date = new Date(resolvedMoveIn);
  if (resolvedEnd !== undefined) leasePatch.end_date = resolvedEnd ? new Date(resolvedEnd) : null;
  if (resolvedDeposit !== undefined) leasePatch.security_deposit = resolvedDeposit;
  if (resolvedStatus !== undefined) leasePatch.status = resolvedStatus;
  if (resolvedUnitId !== undefined) leasePatch.unit_id = resolvedUnitId;
  if (resolvedHouseId !== undefined) leasePatch.house_id = resolvedHouseId;

  // Normalise family_members input (camelCase or snake_case).
  const incomingFamily = family_members ?? familyMembers;
  const validFamily =
    incomingFamily === undefined
      ? undefined
      : Array.isArray(incomingFamily)
        ? incomingFamily
            .filter((m: any) => m && typeof m === "object")
            .map((m: any) => {
              const name = (m.name ?? m.full_name ?? "").toString().trim();
              const relation = (m.relation ?? "").toString().trim();
              return { name, relation };
            })
            .filter((m) => m.name.length > 0 && m.relation.length > 0)
        : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    if (Object.keys(tenantPatch).length > 0) {
      await tx.tenant.update({ where: { id: tenantId }, data: tenantPatch });
    }
    const existingLease = (tenant.leases ?? [])[0];
    if (existingLease && Object.keys(leasePatch).length > 0) {
      await tx.lease.update({
        where: { id: existingLease.id },
        data: leasePatch,
      });
    }
    if (validFamily !== undefined) {
      await tx.tenantFamilyMember.deleteMany({ where: { tenant_id: tenantId } });
      if (validFamily.length > 0) {
        await tx.tenantFamilyMember.createMany({
          data: validFamily.map((m) => ({
            tenant_id: tenantId,
            name: m.name,
            relation: m.relation,
          })),
        });
      }
    }
    return loadOwnedTenant(tenantId, ownerId);
  });

  return NextResponse.json({ data: serializeTenant(updated) });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { tenantId } = await context.params;

  const tenant = await loadOwnedTenant(tenantId, ownerId);
  if (!tenant) {
    return NextResponse.json({ error: "TENANT_NOT_FOUND" }, { status: 404 });
  }

  // Soft-delete the tenant and terminate its active leases in one transaction.
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: { deleted_at: new Date() },
    });
    await tx.lease.updateMany({
      where: { tenant_id: tenantId, status: "ACTIVE" },
      data: { status: "TERMINATED", ended_reason: "TENANT_DELETED" },
    });
  });

  return NextResponse.json({ data: { id: tenantId, deleted: true } });
}