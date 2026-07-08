import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const houseId = request.nextUrl.searchParams.get("houseId");
  const tenantId = request.nextUrl.searchParams.get("tenantId");

  const leases = await prisma.lease.findMany({
    where: {
      ...(houseId ? { house_id: houseId } : {}),
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    orderBy: { created_at: "desc" },
  });

  return NextResponse.json({ data: leases });
}

export async function POST(request: NextRequest) {
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

  const unit = await prisma.unit.findFirst({
    where: { id: unitId, house_id: houseId },
  });

  if (!unit) {
    return NextResponse.json(
      { error: "The requested unit was not found in the selected house." },
      { status: 404 }
    );
  }

  const activeLease = await prisma.lease.findFirst({
    where: { unit_id: unitId, status: "ACTIVE" },
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
  });

  return NextResponse.json({ data: lease }, { status: 201 });
}
