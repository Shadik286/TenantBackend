import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { invalidateAllReportSnapshotsForHouse } from "@/lib/report-cache";

export const runtime = "nodejs";

/**
 * Manual cache flush endpoint. Drops every `ReportSnapshot` row for the
 * given house so the next GET /api/reports/[houseId] rebuilds from
 * scratch.
 *
 * This is intentionally separate from the GET handler because the
 * invalidation triggered by expense/payment POST/PATCH/DELETE can fail
 * silently (see lib/report-cache.ts — error logging is on, but the
 * helper is still best-effort by design). If a user reports "my monthly
 * report shows stale totals", this endpoint lets them recover without a
 * redeploy.
 *
 * POST /api/reports/[houseId]/invalidate
 *   - 200: { data: { house_id, dropped: number } }
 *   - 403: caller does not own the house
 *   - 404: house not found
 */
export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ houseId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { houseId } = await context.params;

  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
    select: { id: true },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }

  // Count first so the response can tell the user how many snapshots
  // were flushed — useful for confirming the endpoint actually ran.
  const before = await prisma.reportSnapshot.count({
    where: { house_id: houseId },
  });
  await invalidateAllReportSnapshotsForHouse(houseId);
  const after = await prisma.reportSnapshot.count({
    where: { house_id: houseId },
  });

  return NextResponse.json({
    data: { house_id: houseId, dropped: before - after },
  });
}