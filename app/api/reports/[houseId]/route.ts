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
 *       ]
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
  }

  // Expenses: bucket by expense_date.
  for (const e of expenses) {
    const d = e.expense_date;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = expenseByMonth.get(key);
    if (cur) expenseByMonth.set(key, cur.add(e.amount));
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
  };
}