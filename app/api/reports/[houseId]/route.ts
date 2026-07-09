import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * GET /api/reports/[houseId]
 *
 * Query params:
 *   - period: "monthly" (default) or "yearly"
 *   - month:  "YYYY-MM"  (required for monthly; defaults to current month)
 *   - year:   "YYYY"     (required for yearly;  defaults to current year)
 *
 * Response shape (both periods share the outer envelope):
 *   {
 *     data: {
 *       house: { id, name },
 *       period_type: "MONTHLY" | "YEARLY",
 *       period_key:  "2026-06" | "2026",
 *       currency: "USD",
 *
 *       // Summary cards
 *       total_rent_collected: "1234.56",
 *       total_other_income:   "0.00",
 *       total_expenses:       "900.00",
 *       net_income:           "334.56",
 *       overdue_amount:       "200.00",
 *       occupied_units: 4,
 *       vacant_units:   1,
 *       payments_count: 3,
 *       expenses_count: 5,
 *
 *       // Monthly only
 *       rent_roll: [
 *         { unit_id, unit_name, tenant_name, amount_due, amount_paid, status }
 *       ],
 *       expense_detail: [
 *         { id, date, category, description, unit_name, amount }
 *       ],
 *       payment_detail: [
 *         { id, date_paid, unit_name, tenant_name, amount, method, status }
 *       ],
 *
 *       // Yearly only
 *       monthly_breakdown: [
 *         { month: "2026-01", label: "Jan", income, expenses, net }
 *       ],
 *       rent_by_unit: [
 *         { unit_id, unit_name, by_month: { "2026-01": "13500", ... }, year_total }
 *       ],
 *       expense_summary: [
 *         { month: "2026-02", label: "Feb", description: "500 tk lights; ..." }
 *       ],
 *       // Annual-grid cells: rows = months, columns = category_columns.
 *       // One entry per (month x category), including zero-amount cells.
 *       expense_cells: [
 *         { month: "2026-01", category: "MAINTENANCE", amount: "0.00", description: "" },
 *         ...
 *       ],
 *       category_columns: ["MAINTENANCE", "UTILITIES", ...],
 *       expense_total_by_month: { "2026-01": "0.00", ... }
 *     }
 *   }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ houseId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const { houseId } = await params;
  if (!houseId) {
    return NextResponse.json({ error: "MISSING_HOUSE_ID" }, { status: 400 });
  }

  // Confirm the house belongs to the caller (and isn't soft-deleted).
  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
    select: { id: true, name: true },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }

  const sp = request.nextUrl.searchParams;
  const period = (sp.get("period") ?? "monthly").toLowerCase();
  if (period !== "monthly" && period !== "yearly") {
    return NextResponse.json(
      { error: "INVALID_PERIOD", message: "period must be 'monthly' or 'yearly'" },
      { status: 400 },
    );
  }

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentYear = String(now.getFullYear());

  if (period === "monthly") {
    const month = sp.get("month") ?? currentMonth;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "INVALID_MONTH", message: "month must be 'YYYY-MM'" },
        { status: 400 },
      );
    }
    try {
      const data = await buildMonthlyReport(houseId, month);
      return NextResponse.json({ data });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return NextResponse.json(
        { error: "INTERNAL_ERROR", message },
        { status: 500 },
      );
    }
  }

  // yearly
  const year = sp.get("year") ?? currentYear;
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json(
      { error: "INVALID_YEAR", message: "year must be 'YYYY'" },
      { status: 400 },
    );
  }
  try {
    const data = await buildYearlyReport(houseId, year);
    return NextResponse.json({ data });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 },
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function decToStr(d: Prisma.Decimal | null | undefined): string {
  return (d ?? new Prisma.Decimal(0)).toFixed(2);
}

function getMonthBounds(ym: string): [Date, Date] {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  return [start, end];
}

function getYearBounds(year: string): [Date, Date] {
  const y = Number(year);
  return [
    new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0)),
    new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0, 0)),
  ];
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const safeM = m >= 1 && m <= 12 ? m : 1;
  return `${names[safeM - 1]} ${y}`;
}

/* -------------------------------------------------------------------------- */
/*                              Monthly report                                */
/* -------------------------------------------------------------------------- */

async function buildMonthlyReport(houseId: string, month: string) {
  const [startDate, endDate] = getMonthBounds(month);

  // We need the house row to populate the `house: { id, name }` field on
  // the response. The GET handler already validated it exists and belongs
  // to the caller, but this helper is called standalone in some flows too,
  // so we re-fetch and rely on Prisma's soft-delete filter.
  const house = await prisma.house.findFirst({
    where: { id: houseId, deleted_at: null },
    select: { id: true, name: true },
  });
  if (!house) {
    throw new Error(`House ${houseId} not found while building monthly report.`);
  }

  // Cache lookup: a finalized snapshot for this (house, period, key) is
  // identical to a fresh compute, so serve it straight from JSONB instead
  // of running the full 5-way join. The schema has
  // `@@unique([house_id, period_type, period_key])` on `ReportSnapshot`,
  // so this is a single indexed point-lookup. We always compute fresh
  // when no final snapshot exists, then UPSERT it so the next request
  // is a one-row read.
  const cached = await prisma.reportSnapshot.findUnique({
    where: {
      house_id_period_type_period_key: {
        house_id: houseId,
        period_type: "MONTHLY",
        period_key: month,
      },
    },
    select: { data: true, is_final: true },
  });
  if (cached?.is_final) {
    return cached.data as any;
  }

  const [
    charges,
    expenses,
    otherIncomeAgg,
    payments,
    units,
  ] = await Promise.all([
    prisma.rentCharge.findMany({
      where: {
        house_id: houseId,
        due_month: month,
        voided_at: null,
      },
      include: {
        payments: { where: { status: "CONFIRMED" } },
        unit: { select: { id: true, name: true } },
        lease: {
          include: { tenant: { select: { id: true, full_name: true } } },
        },
      },
      orderBy: { due_date: "asc" },
    }),
    prisma.expense.findMany({
      where: {
        house_id: houseId,
        deleted_at: null,
        expense_date: { gte: startDate, lt: endDate },
      },
      include: { unit: { select: { id: true, name: true } } },
      orderBy: { expense_date: "desc" },
    }),
    prisma.otherIncome.aggregate({
      where: {
        house_id: houseId,
        deleted_at: null,
        income_date: { gte: startDate, lt: endDate },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    // All confirmed payments in this month for the "Rent Payments" table.
    prisma.payment.findMany({
      where: {
        status: "CONFIRMED",
        rent_charge: {
          house_id: houseId,
          due_month: month,
          voided_at: null,
        },
      },
      include: {
        rent_charge: {
          include: {
            unit: { select: { id: true, name: true } },
            lease: {
              include: { tenant: { select: { id: true, full_name: true } } },
            },
          },
        },
      },
      orderBy: { date_paid: "desc" },
    }),
    prisma.unit.findMany({
      where: { house_id: houseId, deleted_at: null },
      include: {
        leases: {
          where: { status: "ACTIVE" },
          select: { id: true },
        },
      },
    }),
  ]);

  // Total rent collected = sum of confirmed payment amounts in this month.
  let totalRentCollected = new Prisma.Decimal(0);
  for (const p of payments) {
    totalRentCollected = totalRentCollected.add(p.amount);
  }

  let totalOtherIncome = new Prisma.Decimal(0);
  if (otherIncomeAgg._sum.amount) {
    totalOtherIncome = new Prisma.Decimal(otherIncomeAgg._sum.amount.toString());
  }

  let totalExpenses = new Prisma.Decimal(0);
  for (const e of expenses) {
    totalExpenses = totalExpenses.add(e.amount);
  }
  const netIncome = totalRentCollected
    .add(totalOtherIncome)
    .sub(totalExpenses);

  // Overdue amount = sum of amount_due on OVERDUE charges (not yet paid).
  let overdueAmount = new Prisma.Decimal(0);
  for (const c of charges) {
    if (c.status === "OVERDUE") {
      overdueAmount = overdueAmount.add(c.amount_due);
    }
  }

  const occupiedUnits = units.filter((u) => u.leases.length > 0).length;
  const vacantUnits = units.length - occupiedUnits;

  const rentRoll = charges.map((c) => {
    const paid = c.payments.reduce(
      (s, p) => s.add(p.amount),
      new Prisma.Decimal(0),
    );
    return {
      unit_id: c.unit_id,
      unit_name: c.unit.name,
      tenant_name: c.lease.tenant.full_name,
      amount_due: decToStr(c.amount_due),
      amount_paid: paid.toFixed(2),
      status: c.status,
    };
  });

  const expenseDetail = expenses.map((e) => ({
    id: e.id,
    date: e.expense_date.toISOString(),
    category: e.category,
    custom_category: e.custom_category ?? null,
    description: e.description ?? "",
    vendor: e.vendor ?? null,
    unit_id: e.unit_id ?? null,
    unit_name: e.unit?.name ?? null,
    amount: decToStr(e.amount),
  }));

  const paymentDetail = payments.map((p) => ({
    id: p.id,
    date_paid: p.date_paid.toISOString(),
    unit_id: p.rent_charge.unit.id,
    unit_name: p.rent_charge.unit.name,
    tenant_name: p.rent_charge.lease.tenant.full_name,
    amount: decToStr(p.amount),
    method: p.method,
    status: p.status,
    reference_no: p.reference_no ?? null,
  }));

  return {
    house: { id: house.id, name: house.name },
    period_type: "MONTHLY" as const,
    period_key: month,
    period_label: monthLabel(month),
    currency: "USD",

    total_rent_collected: totalRentCollected.toFixed(2),
    total_other_income: totalOtherIncome.toFixed(2),
    total_expenses: totalExpenses.toFixed(2),
    net_income: netIncome.toFixed(2),
    overdue_amount: overdueAmount.toFixed(2),
    occupied_units: occupiedUnits,
    vacant_units: vacantUnits,
    payments_count: payments.length,
    expenses_count: expenses.length,
    other_income_count: otherIncomeAgg._count._all ?? 0,

    rent_roll: rentRoll,
    expense_detail: expenseDetail,
    payment_detail: paymentDetail,
  };

  // Fire-and-await UPSERT into ReportSnapshot so the next request for this
  // (house, MONTHLY, month) is a single indexed point-lookup instead of a
  // full 5-way join. We store the raw JSONB the GET handler would otherwise
  // send over the wire so the cache hit path is zero-copy. The unique
  // constraint on (house_id, period_type, period_key) guarantees a single
  // row per period, so this is the correct shape.
  const report = {
    house: { id: house.id, name: house.name },
    period_type: "MONTHLY" as const,
    period_key: month,
    period_label: monthLabel(month),
    currency: "USD",

    total_rent_collected: totalRentCollected.toFixed(2),
    total_other_income: totalOtherIncome.toFixed(2),
    total_expenses: totalExpenses.toFixed(2),
    net_income: netIncome.toFixed(2),
    overdue_amount: overdueAmount.toFixed(2),
    occupied_units: occupiedUnits,
    vacant_units: vacantUnits,
    payments_count: payments.length,
    expenses_count: expenses.length,
    other_income_count: otherIncomeAgg._count._all ?? 0,

    rent_roll: rentRoll,
    expense_detail: expenseDetail,
    payment_detail: paymentDetail,
  };

  try {
    await prisma.reportSnapshot.upsert({
      where: {
        house_id_period_type_period_key: {
          house_id: houseId,
          period_type: "MONTHLY",
          period_key: month,
        },
      },
      create: {
        house_id: houseId,
        period_type: "MONTHLY",
        period_key: month,
        total_rent_collected: new Prisma.Decimal(report.total_rent_collected),
        total_other_income: new Prisma.Decimal(report.total_other_income),
        total_expenses: new Prisma.Decimal(report.total_expenses),
        net_income: new Prisma.Decimal(report.net_income),
        occupied_units: report.occupied_units,
        vacant_units: report.vacant_units,
        overdue_amount: new Prisma.Decimal(report.overdue_amount),
        rent_roll: report.rent_roll as any,
        data: report as any,
        is_final: true,
      },
      update: {
        total_rent_collected: new Prisma.Decimal(report.total_rent_collected),
        total_other_income: new Prisma.Decimal(report.total_other_income),
        total_expenses: new Prisma.Decimal(report.total_expenses),
        net_income: new Prisma.Decimal(report.net_income),
        occupied_units: report.occupied_units,
        vacant_units: report.vacant_units,
        overdue_amount: new Prisma.Decimal(report.overdue_amount),
        rent_roll: report.rent_roll as any,
        data: report as any,
        is_final: true,
        updated_at: new Date(),
      },
    });
  } catch {
    // Snapshot write is best-effort — never fail the request because the
    // cache layer hiccuped; the next request will simply recompute.
  }

  return report;
}

/* -------------------------------------------------------------------------- */
/*                               Yearly report                                */
/* -------------------------------------------------------------------------- */

async function buildYearlyReport(houseId: string, year: string) {
  const [startDate, endDate] = getYearBounds(year);

  const house = await prisma.house.findFirst({
    where: { id: houseId, deleted_at: null },
    select: { id: true, name: true },
  });
  if (!house) {
    throw new Error(`House ${houseId} not found while building yearly report.`);
  }

  // Cache lookup: same pattern as the monthly report. A finalised
  // ReportSnapshot row for (house, YEARLY, year) means the full
  // aggregation has been done before and we can serve it as-is.
  const cached = await prisma.reportSnapshot.findUnique({
    where: {
      house_id_period_type_period_key: {
        house_id: houseId,
        period_type: "YEARLY",
        period_key: year,
      },
    },
    select: { data: true, is_final: true },
  });
  if (cached?.is_final) {
    return cached.data as any;
  }

  const [
    charges,
    expenses,
    otherIncomeAgg,
    payments,
    units,
  ] = await Promise.all([
    prisma.rentCharge.findMany({
      where: {
        house_id: houseId,
        voided_at: null,
        due_month: { gte: `${year}-01`, lte: `${year}-12` },
      },
      include: {
        payments: { where: { status: "CONFIRMED" } },
      },
    }),
    prisma.expense.findMany({
      where: {
        house_id: houseId,
        deleted_at: null,
        expense_date: { gte: startDate, lt: endDate },
      },
    }),
    prisma.otherIncome.aggregate({
      where: {
        house_id: houseId,
        deleted_at: null,
        income_date: { gte: startDate, lt: endDate },
      },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payment.findMany({
      where: {
        status: "CONFIRMED",
        date_paid: { gte: startDate, lt: endDate },
        rent_charge: { house_id: houseId, voided_at: null },
      },
      select: { amount: true, date_paid: true },
    }),
    prisma.unit.findMany({
      where: { house_id: houseId, deleted_at: null },
      include: {
        leases: {
          where: { status: "ACTIVE" },
          select: { id: true },
        },
      },
    }),
  ]);

  // Build the 12-month breakdown (Jan..Dec).
  const months = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, "0");
    return `${year}-${mm}`;
  });

  const incomeByMonth = new Map<string, Prisma.Decimal>();
  const expenseByMonth = new Map<string, Prisma.Decimal>();
  // Per-unit × per-month rent collection matrix (unit_id -> month -> Decimal).
  const rentByUnitMonth = new Map<string, Map<string, Prisma.Decimal>>();
  // Per-unit display name cache (unit_id -> name).
  const unitNameById = new Map<string, string>();
  for (const u of units) {
    unitNameById.set(u.id, u.name);
    rentByUnitMonth.set(
      u.id,
      new Map(months.map((m) => [m, new Prisma.Decimal(0)])),
    );
  }
  // Monthly short-description fragments, e.g. { "2026-02": "500 tk lights,
  // 55000 lillah on 21 feb" }. Concatenated per month across expenses +
  // confirmed payments in that month so the user sees what happened.
  const descByMonth = new Map<string, string[]>();
  for (const m of months) descByMonth.set(m, []);

  for (const m of months) {
    incomeByMonth.set(m, new Prisma.Decimal(0));
    expenseByMonth.set(m, new Prisma.Decimal(0));
  }

  // Payments: bucket by the payment's own date_paid (not charge due_month).
  for (const p of payments) {
    const d = p.date_paid;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = incomeByMonth.get(key);
    if (cur) incomeByMonth.set(key, cur.add(p.amount));
    // Per-unit contribution to rent for this month. `p` here was selected
    // with just { amount, date_paid }, so we need to re-join via the
    // rent_charge to know which unit. We re-query below.
  }

  // To populate rent_by_unit we need (unit_id, date_paid, amount) tuples.
  // Re-fetch with the join — keeps the main `payments` query above lean.
  const paymentsForMatrix = await prisma.payment.findMany({
    where: {
      status: "CONFIRMED",
      date_paid: { gte: startDate, lt: endDate },
      rent_charge: { house_id: houseId, voided_at: null },
    },
    select: {
      amount: true,
      date_paid: true,
      rent_charge: { select: { unit_id: true } },
    },
  });
  for (const p of paymentsForMatrix) {
    const unitId = p.rent_charge.unit_id;
    const perUnit = rentByUnitMonth.get(unitId);
    if (!perUnit) continue;
    const key = `${p.date_paid.getUTCFullYear()}-${String(p.date_paid.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = perUnit.get(key);
    if (cur) perUnit.set(key, cur.add(p.amount));
  }

  // Expenses: bucket by expense_date + collect per-month descriptions.
  for (const e of expenses) {
    const d = e.expense_date;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = expenseByMonth.get(key);
    if (cur) expenseByMonth.set(key, cur.add(e.amount));

    // Short description fragment: "{amount} {description or category}"
    // e.g. "500 tk lights" or "55000 lillah on 21 feb". Keeps it scannable.
    const arr = descByMonth.get(key);
    if (arr) {
      const amt = e.amount.toFixed(0);
      const label = (e.description && e.description.trim()) || e.category;
      // Trim and clamp to 60 chars to avoid one cell exploding.
      const trimmed = label.trim().slice(0, 60);
      arr.push(`${amt} ${trimmed}`);
    }
  }

  const monthlyBreakdown = months.map((m) => {
    const income = incomeByMonth.get(m) ?? new Prisma.Decimal(0);
    const expense = expenseByMonth.get(m) ?? new Prisma.Decimal(0);
    return {
      month: m,
      label: monthLabel(m).split(" ")[0],
      income: income.toFixed(2),
      expenses: expense.toFixed(2),
      net: income.sub(expense).toFixed(2),
    };
  });

  // rent_by_unit: one row per active unit, sorted by total collected
  // (desc) so the highest-earning unit is at the top — matches the
  // user's spreadsheet layout ("# 1st", "# 2nd", ...).
  const rentByUnit = Array.from(rentByUnitMonth.entries())
    .map(([unitId, perMonth]) => {
      let yearTotal = new Prisma.Decimal(0);
      const byMonth: Record<string, string> = {};
      for (const m of months) {
        const v = perMonth.get(m) ?? new Prisma.Decimal(0);
        byMonth[m] = v.toFixed(2);
        yearTotal = yearTotal.add(v);
      }
      return {
        unit_id: unitId,
        unit_name: unitNameById.get(unitId) ?? "Unit",
        by_month: byMonth,
        year_total: yearTotal.toFixed(2),
      };
    })
    .sort((a, b) => Number(b.year_total) - Number(a.year_total));

  // expense_summary: one row per month, with a free-text "description"
  // assembled from the actual expense records (and short notes from
  // confirmed payments) for that month. Empty months are skipped.
  const expenseSummary = months
    .map((m) => {
      const frags = descByMonth.get(m) ?? [];
      return {
        month: m,
        label: monthLabel(m).split(" ")[0],
        description: frags.join("; "),
      };
    })
    .filter((row) => row.description.length > 0);

  // --- Annual-grid expense cells ---------------------------------------
  // For the "months-as-rows, categories-as-columns" grid on the Yearly
  // view, we need:
  //   - `category_columns`: the ordered list of category labels (using
  //     `custom_category` when the row used the OTHER enum bucket),
  //     surfaced in the same order as the Prisma `ExpenseCategory` enum
  //     so the grid stays stable across requests.
  //   - `expense_cells`: one row per (month, category) with the rolled-up
  //     amount and the per-category description fragments. Empty cells
  //     are still emitted so the frontend can show "—" for blanks.
  //   - `expense_total_by_month`: convenience map so the rightmost "Total
  //     Expns" column is a single lookup instead of a loop on the client.
  const CATEGORY_ORDER: Array<typeof expenses[number]["category"]> = [
    "MAINTENANCE",
    "UTILITIES",
    "INSURANCE",
    "PROPERTY_TAX",
    "MANAGEMENT_FEE",
    "CLEANING",
    "LANDSCAPING",
    "LEGAL",
    "MARKETING",
    "SUPPLIES",
    "RENOVATION",
    "OTHER",
  ];
  const categoryLabel = (e: { category: string; custom_category: string | null }) => {
    if (e.category === "OTHER" && e.custom_category && e.custom_category.trim()) {
      return e.custom_category.trim();
    }
    return e.category;
  };
  // Collect the set of labels actually used this year, then sort them by
  // the enum order so the column layout stays consistent month-to-month.
  const labelsSeen = new Set<string>();
  for (const e of expenses) labelsSeen.add(categoryLabel(e));
  const knownUsed = CATEGORY_ORDER.filter((c) => labelsSeen.has(c));
  const extraUsed = Array.from(labelsSeen).filter(
    (l): l is string => !CATEGORY_ORDER.includes(l as typeof CATEGORY_ORDER[number]),
  );
  const categoryColumns: string[] = [...knownUsed, ...extraUsed];

  // expense_by_month_category[month][categoryLabel] = { amount, description }
  const expenseByMonthCategory = new Map<
    string,
    Map<string, { amount: Prisma.Decimal; description: string[] }>
  >();
  for (const m of months) {
    expenseByMonthCategory.set(m, new Map());
  }
  for (const e of expenses) {
    const d = e.expense_date;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = categoryLabel(e);
    const bucket = expenseByMonthCategory.get(key);
    if (!bucket) continue;
    const cell = bucket.get(label) ?? {
      amount: new Prisma.Decimal(0),
      description: [],
    };
    cell.amount = cell.amount.add(e.amount);
    const desc = (e.description && e.description.trim()) || e.category;
    cell.description.push(desc.trim().slice(0, 60));
    bucket.set(label, cell);
  }

  const expenseCells: Array<{
    month: string;
    category: string;
    amount: string;
    description: string;
  }> = [];
  const expenseTotalByMonth: Record<string, string> = {};
  for (const m of months) {
    let monthTotal = new Prisma.Decimal(0);
    const bucket = expenseByMonthCategory.get(m) ?? new Map();
    for (const cat of categoryColumns) {
      const cell = bucket.get(cat);
      const amount = cell?.amount ?? new Prisma.Decimal(0);
      monthTotal = monthTotal.add(amount);
      expenseCells.push({
        month: m,
        category: cat,
        amount: amount.toFixed(2),
        description: (cell?.description ?? []).join("; "),
      });
    }
    expenseTotalByMonth[m] = monthTotal.toFixed(2);
  }

  // Totals across the whole year.
  let totalRentCollected = new Prisma.Decimal(0);
  for (const v of incomeByMonth.values()) totalRentCollected = totalRentCollected.add(v);
  let totalExpenses = new Prisma.Decimal(0);
  for (const v of expenseByMonth.values()) totalExpenses = totalExpenses.add(v);
  const totalOtherIncome = otherIncomeAgg._sum.amount
    ? new Prisma.Decimal(otherIncomeAgg._sum.amount.toString())
    : new Prisma.Decimal(0);
  const netIncome = totalRentCollected.add(totalOtherIncome).sub(totalExpenses);

  // Overdue amount at the moment in time of this call.
  const overdueCharges = await prisma.rentCharge.aggregate({
    where: { house_id: houseId, status: "OVERDUE", voided_at: null },
    _sum: { amount_due: true },
  });
  const overdueAmount = overdueCharges._sum.amount_due
    ? new Prisma.Decimal(overdueCharges._sum.amount_due.toString())
    : new Prisma.Decimal(0);

  const occupiedUnits = units.filter((u) => u.leases.length > 0).length;
  const vacantUnits = units.length - occupiedUnits;

  return {
    house: { id: house.id, name: house.name },
    period_type: "YEARLY" as const,
    period_key: year,
    period_label: year,
    currency: "USD",

    total_rent_collected: totalRentCollected.toFixed(2),
    total_other_income: totalOtherIncome.toFixed(2),
    total_expenses: totalExpenses.toFixed(2),
    net_income: netIncome.toFixed(2),
    overdue_amount: overdueAmount.toFixed(2),
    occupied_units: occupiedUnits,
    vacant_units: vacantUnits,
    payments_count: payments.length,
    expenses_count: expenses.length,
    other_income_count: otherIncomeAgg._count._all ?? 0,

    monthly_breakdown: monthlyBreakdown,
    rent_by_unit: rentByUnit,
    expense_summary: expenseSummary,
    expense_cells: expenseCells,
    category_columns: categoryColumns,
    expense_total_by_month: expenseTotalByMonth,
  };

  // Persist to ReportSnapshot so the next request for this year is a
  // single indexed point-lookup. Best-effort: a failed cache write must
  // never break the live request.
  const report = {
    house: { id: house.id, name: house.name },
    period_type: "YEARLY" as const,
    period_key: year,
    period_label: year,
    currency: "USD",

    total_rent_collected: totalRentCollected.toFixed(2),
    total_other_income: totalOtherIncome.toFixed(2),
    total_expenses: totalExpenses.toFixed(2),
    net_income: netIncome.toFixed(2),
    overdue_amount: overdueAmount.toFixed(2),
    occupied_units: occupiedUnits,
    vacant_units: vacantUnits,
    payments_count: payments.length,
    expenses_count: expenses.length,
    other_income_count: otherIncomeAgg._count._all ?? 0,

    monthly_breakdown: monthlyBreakdown,
    rent_by_unit: rentByUnit,
    expense_summary: expenseSummary,
    expense_cells: expenseCells,
    category_columns: categoryColumns,
    expense_total_by_month: expenseTotalByMonth,
  };

  try {
    await prisma.reportSnapshot.upsert({
      where: {
        house_id_period_type_period_key: {
          house_id: houseId,
          period_type: "YEARLY",
          period_key: year,
        },
      },
      create: {
        house_id: houseId,
        period_type: "YEARLY",
        period_key: year,
        total_rent_collected: new Prisma.Decimal(report.total_rent_collected),
        total_other_income: new Prisma.Decimal(report.total_other_income),
        total_expenses: new Prisma.Decimal(report.total_expenses),
        net_income: new Prisma.Decimal(report.net_income),
        occupied_units: report.occupied_units,
        vacant_units: report.vacant_units,
        overdue_amount: new Prisma.Decimal(report.overdue_amount),
        rent_roll: [],
        data: report as any,
        is_final: true,
      },
      update: {
        total_rent_collected: new Prisma.Decimal(report.total_rent_collected),
        total_other_income: new Prisma.Decimal(report.total_other_income),
        total_expenses: new Prisma.Decimal(report.total_expenses),
        net_income: new Prisma.Decimal(report.net_income),
        occupied_units: report.occupied_units,
        vacant_units: report.vacant_units,
        overdue_amount: new Prisma.Decimal(report.overdue_amount),
        data: report as any,
        is_final: true,
        updated_at: new Date(),
      },
    });
  } catch {
    // Cache write is best-effort; never fail the request because the
    // snapshot layer hiccuped.
  }

  return report;
}