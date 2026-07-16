import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Best-effort invalidation of the `ReportSnapshot` cache. The cache is keyed
 * by `(house_id, period_type, period_key)`, where `period_key` is
 *   * `"YYYY-MM"` for MONTHLY snapshots
 *   * `"YYYY"`   for YEARLY snapshots
 *
 * When any underlying expense/payment/rent-charge/lease row changes we drop
 * the matching snapshots so the next /api/reports/[houseId] request has to
 * recompute (and repersist) — otherwise the new row is invisible to the
 * report PDF even though it shows up everywhere else.
 *
 * Like the cache-write path, failures are swallowed: a broken snapshot
 * invalidation must never break the originating write.
 */
export async function invalidateReportSnapshotsForHouse(
  houseId: string,
  options: {
    /**
     * Restrict to MONTHLY snapshots with this `"YYYY-MM"` key.
     * Pass `monthKey` to drop a single month; omit for all MONTHLY+all
     * YEARLY snapshots for the house.
     */
    monthKey?: string;
    /**
     * Restrict to YEARLY snapshots with this `"YYYY"` key.
     */
    yearKey?: string;
    /**
     * Restrict to one period type. Defaults to "both".
     */
    periodType?: "MONTHLY" | "YEARLY";
  } = {},
): Promise<void> {
  try {
    const types: Array<"MONTHLY" | "YEARLY"> = options.periodType
      ? [options.periodType]
      : ["MONTHLY", "YEARLY"];

    const namedKeys: string[] = [];
    if (options.monthKey) namedKeys.push(options.monthKey);
    if (options.yearKey) namedKeys.push(options.yearKey);

    const wheres: Prisma.ReportSnapshotWhereInput[] = [];
    for (const t of types) {
      if (namedKeys.length > 0) {
        for (const k of namedKeys) {
          wheres.push({ house_id: houseId, period_type: t, period_key: k });
        }
      } else {
        wheres.push({ house_id: houseId, period_type: t });
      }
    }

    const res = await prisma.reportSnapshot.deleteMany({
      where: { OR: wheres },
    });
    if (res.count > 0) {
      console.log(
        `[report-cache] invalidated ${res.count} snapshot(s) for house=${houseId}`,
        { wheres },
      );
    }
  } catch (e) {
    // Cache invalidation is best-effort, but we MUST surface failures:
    // silently dropping the delete means the report PDF keeps showing
    // stale totals after every expense/payment mutation, which is the
    // user-visible bug this helper exists to prevent.
    console.error("[report-cache] invalidateReportSnapshotsForHouse failed", {
      houseId,
      options,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Convenience helper for the POST/PATCH/DELETE handlers that don't carry
 * any date context: drop every cached snapshot for the house.
 */
export async function invalidateAllReportSnapshotsForHouse(
  houseId: string,
): Promise<void> {
  return invalidateReportSnapshotsForHouse(houseId);
}
