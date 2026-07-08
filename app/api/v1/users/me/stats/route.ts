import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const userId = guard.userId;

  const [houses, units, tenants, activeLeases] = await Promise.all([
    prisma.house.count({
      where: { owner_id: userId, deleted_at: null },
    }),
    prisma.unit.count({
      where: {
        deleted_at: null,
        house: { owner_id: userId, deleted_at: null },
      },
    }),
    prisma.tenant.count({
      where: { owner_id: userId, deleted_at: null },
    }),
    prisma.lease.count({
      where: {
        status: "ACTIVE",
        house: { owner_id: userId, deleted_at: null },
      },
    }),
  ]);

  return NextResponse.json({
    data: {
      houses,
      units,
      tenants,
      active_leases: activeLeases,
    },
  });
}