import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Serializes a RentCharge row with the unit + tenant + house joined so the
 * Flutter "Add Payment" form can show "{Unit A1 • John Smith • Due 2026-06-01}"
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
 * GET /api/rent-charges
 *
 * Query params:
 *   - houseId: filter to a single house
 *   - month:   "YYYY-MM" (matches due_month exactly)
 *   - unitId:  filter to a single unit
 *
 * Used by the Flutter Finances tab to populate the "Add Payment" dropdown
 * of pending charges for the selected month.
 *
 * NOTE: bulk-generating charges for a month lives at
 * `POST /api/rent-charges/generate-for-month` (see
 * `./generate-for-month/route.ts`). This route is GET-only.
 */
export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const sp = request.nextUrl.searchParams;
  const houseId = sp.get("houseId");
  const month = sp.get("month");
  const unitId = sp.get("unitId");

  const charges = await prisma.rentCharge.findMany({
    where: {
      voided_at: null,
      house: {
        owner_id: ownerId,
        deleted_at: null,
        ...(houseId ? { id: houseId } : {}),
      },
      ...(month ? { due_month: month } : {}),
      ...(unitId ? { unit_id: unitId } : {}),
    },
    orderBy: [{ due_date: "asc" }],
    include: { unit: true, tenant: true },
  });

  return NextResponse.json({ data: charges.map(serializeCharge) });
}
