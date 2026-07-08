import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Serializes a RentCharge row with the unit + tenant joined so the Flutter
 * "Add Payment" form can show "{Unit A1 • John Smith • Due 2026-06-01}"
 * without further requests.
 */
function serializeCharge(c: any) {
  return {
    id: c.id,
    house_id: c.house_id,
    unit_id: c.unit_id,
    unit_name: c.unit?.name ?? null,
    tenant_id: c.tenant_id,
    tenant_name: c.tenant?.full_name ?? null,
    due_month: c.due_month,
    due_date: c.due_date,
    amount_due: Number(c.amount_due ?? "0"),
    status: c.status,
    notes: c.notes ?? null,
    voided_at: c.voided_at ?? null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

/**
 * POST /api/rent-charges/generate-for-month
 *
 * Bulk-creates RentCharge rows for every ACTIVE lease in the given house for
 * the given "YYYY-MM" month. Idempotent on the
 * @@unique([unit_id, lease_id, due_month]) constraint: leases that already
 * have a charge for the month are skipped.
 *
 * Body:
 *   - houseId: required
 *   - month:   "YYYY-MM" (defaults to current month)
 *   - defaultAmount (optional): number used when a unit has no RentRate yet
 *
 * Returns:
 *   { data: { created: number, skipped: number, skipped_no_rate: number, charges: [...] } }
 *
 * Called by the Flutter Finances tab when the user tries to record income
 * for a month that has no charges yet — the snackbar offers a one-tap
 * "Create charges for {Month}" action that hits this endpoint.
 */
export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  let body: { houseId?: string; month?: string; defaultAmount?: string | number };
  try {
    body = (await request.json()) as { houseId?: string; month?: string; defaultAmount?: string | number };
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const houseId = body.houseId;
  if (!houseId) {
    return NextResponse.json({ error: "houseId is required." }, { status: 400 });
  }

  // Optional fallback amount used when a unit has no RentRate yet. The
  // Flutter "Add Income" prompt lets the user type a number here so the
  // charge can still be created for that unit.
  let defaultAmount: Prisma.Decimal | null = null;
  if (body.defaultAmount !== undefined && body.defaultAmount !== null && body.defaultAmount !== "") {
    const n = Number(body.defaultAmount);
    if (!Number.isNaN(n) && n >= 0) {
      defaultAmount = new Prisma.Decimal(body.defaultAmount as any);
    }
  }

  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
    select: { id: true },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }

  // Default to the current month in YYYY-MM form.
  const month =
    body.month && /^\d{4}-\d{2}$/.test(body.month)
      ? body.month
      : new Date().toISOString().slice(0, 7);

  const dueDate = new Date(`${month}-01T00:00:00.000Z`);

  // Every ACTIVE lease in the house for the requested month.
  const leases = await prisma.lease.findMany({
    where: {
      house_id: houseId,
      status: "ACTIVE",
      // Lease must be live by the due date (started on or before the 1st of
      // the month) and not already ended before then.
      start_date: { lte: dueDate },
      OR: [{ end_date: null }, { end_date: { gte: dueDate } }],
    },
    include: {
      unit: {
        include: {
          rent_rates: {
            where: { effective_to: null },
            orderBy: { effective_from: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  if (leases.length === 0) {
    return NextResponse.json({
      data: {
        month,
        house_id: houseId,
        created: 0,
        skipped: 0,
        skipped_no_rate: 0,
        charges: [],
      },
    });
  }

  // Pre-fetch existing charges for this month so we can report accurate
  // counts without relying solely on the create throwing on the unique
  // constraint.
  const existing = await prisma.rentCharge.findMany({
    where: {
      house_id: houseId,
      due_month: month,
      lease_id: { in: leases.map((l) => l.id) },
    },
    include: { unit: true, tenant: true },
  });
  const existingByLease = new Map(existing.map((c) => [c.lease_id, c]));

  const created: any[] = [];
  let skipped = 0;
  let skippedNoRate = 0;

  for (const lease of leases) {
    if (existingByLease.has(lease.id)) {
      skipped += 1;
      continue;
    }
    const rate = lease.unit.rent_rates[0];
    if (!rate) {
      // No rate configured for the unit. If the caller supplied a
      // defaultAmount we use it; otherwise we skip and report it so the
      // UI can prompt for an amount.
      if (defaultAmount === null) {
        skippedNoRate += 1;
        continue;
      }
      const charge = await prisma.rentCharge.create({
        data: {
          house_id: houseId,
          unit_id: lease.unit_id,
          lease_id: lease.id,
          tenant_id: lease.tenant_id,
          due_month: month,
          due_date: dueDate,
          amount_due: defaultAmount,
          status: "UNPAID",
          notes: "Default amount — set a RentRate for this unit to use a stored value.",
        },
        include: { unit: true, tenant: true },
      });
      created.push(charge);
      continue;
    }
    const charge = await prisma.rentCharge.create({
      data: {
        house_id: houseId,
        unit_id: lease.unit_id,
        lease_id: lease.id,
        tenant_id: lease.tenant_id,
        due_month: month,
        due_date: dueDate,
        amount_due: rate.amount,
        status: "UNPAID",
      },
      include: { unit: true, tenant: true },
    });
    created.push(charge);
  }

  // Merge created + pre-existing for a single response payload.
  const allCharges = [...existing, ...created];
  return NextResponse.json({
    data: {
      month,
      house_id: houseId,
      created: created.length,
      skipped,
      skipped_no_rate: skippedNoRate,
      charges: allCharges.map(serializeCharge),
    },
  });
}