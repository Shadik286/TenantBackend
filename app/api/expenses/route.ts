import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import {
  invalidateReportSnapshotsForHouse,
} from "@/lib/report-cache";

export const runtime = "nodejs";

const EXPENSE_CATEGORIES = [
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
] as const;

function serializeExpense(e: any) {
  const unit = e.unit ?? null;
  return {
    id: e.id,
    house_id: e.house_id,
    unit_id: e.unit_id ?? null,
    unit_name: unit?.name ?? null,
    category: e.category,
    custom_category: e.custom_category ?? null,
    amount: Number(e.amount ?? "0"),
    currency: "USD",
    expense_date: e.expense_date,
    description: e.description ?? null,
    vendor: e.vendor ?? null,
    receipt_url: e.receipt_url ?? null,
    created_by: e.created_by,
    created_at: e.created_at,
    updated_at: e.updated_at,
  };
}

const CreateExpenseSchema = z.object({
  house_id: z.string().uuid(),
  unit_id: z.string().uuid().optional().nullable(),
  category: z.enum(EXPENSE_CATEGORIES),
  custom_category: z.string().max(80).optional().nullable(),
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? v : v.toString()))
    .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
      message: "amount must be a non-negative number",
    }),
  expense_date: z.string().min(1),
  description: z.string().max(2000).optional().nullable(),
  vendor: z.string().max(120).optional().nullable(),
  // Cloudinary URL produced by /api/uploads/cloudinary. Validated as a URL so
  // a malformed value is rejected here rather than rendering as a broken
  // image in the app.
  receipt_url: z.string().url().max(2048).optional().nullable(),
});

/**
 * Lists expenses scoped to the caller's houses. Accepts:
 *   - houseId: required-ish; UI always passes one. Omitted -> ALL houses for owner.
 *   - month: "YYYY-MM" applied to expense_date range.
 *   - year:  "YYYY" applied to expense_date range when no month is given.
 *            Used by the annual report to list every expense of the year.
 *   - category: filter to a single ExpenseCategory.
 *
 * Soft-deleted rows (`deleted_at IS NOT NULL`) are excluded.
 */
export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const sp = request.nextUrl.searchParams;
  const houseId = sp.get("houseId");
  const month = sp.get("month"); // YYYY-MM
  const category = sp.get("category");
  const year = sp.get("year"); // YYYY
  const yearNum = year && /^\d{4}$/.test(year) ? Number(year) : null;

  // Cap at 200 rows. Finances tab never needs more; prevents accidental
  // full-table scans from making the page slow to render.
  const take = Math.min(
    Math.max(Number(sp.get("take")) || 200, 1),
    500,
  );

  const expenses = await prisma.expense.findMany({
    where: {
      deleted_at: null,
      house: {
        owner_id: ownerId,
        deleted_at: null,
        ...(houseId ? { id: houseId } : {}),
      },
      ...(month
        ? {
            expense_date: {
              gte: new Date(`${month}-01T00:00:00.000Z`),
              lt: new Date(
                new Date(`${month}-01T00:00:00.000Z`).setMonth(
                  new Date(`${month}-01T00:00:00.000Z`).getMonth() + 1,
                ),
              ),
            },
          }
        : yearNum !== null
          ? {
              expense_date: {
                gte: new Date(Date.UTC(yearNum, 0, 1)),
                lt: new Date(Date.UTC(yearNum + 1, 0, 1)),
              },
            }
          : {}),
      ...(category ? { category: category as any } : {}),
    },
    orderBy: { expense_date: "desc" },
    take,
    // Explicit `select` instead of `include` so we skip the `notes`
    // blob (rarely populated) and only ship the columns the UI shows.
    select: {
      id: true,
      house_id: true,
      unit_id: true,
      category: true,
      custom_category: true,
      amount: true,
      expense_date: true,
      description: true,
      vendor: true,
      receipt_url: true,
      created_by: true,
      created_at: true,
      updated_at: true,
      unit: { select: { id: true, name: true } },
    },
  });

  let total = new Prisma.Decimal(0);
  for (const e of expenses) {
    total = total.add(e.amount);
  }

  return NextResponse.json({
    data: expenses.map(serializeExpense),
    summary: {
      expenses_total: total.toFixed(2),
      expenses_count: expenses.length,
      month: month ?? null,
      house_id: houseId ?? null,
    },
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = CreateExpenseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // Verify the target house (and optional unit) belong to the caller.
  const house = await prisma.house.findFirst({
    where: { id: input.house_id, owner_id: ownerId, deleted_at: null },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }
  if (input.unit_id) {
    const unit = await prisma.unit.findFirst({
      where: {
        id: input.unit_id,
        house_id: input.house_id,
        deleted_at: null,
      },
    });
    if (!unit) {
      return NextResponse.json({ error: "UNIT_NOT_FOUND" }, { status: 404 });
    }
  }

  const expenseDate = new Date(input.expense_date);
  if (Number.isNaN(expenseDate.getTime())) {
    return NextResponse.json(
      { error: "INVALID_DATE", message: "expense_date is not a valid ISO date" },
      { status: 400 },
    );
  }

  try {
    const created = await prisma.expense.create({
      data: {
        house_id: input.house_id,
        unit_id: input.unit_id ?? null,
        category: input.category,
        custom_category: input.custom_category ?? null,
        amount: new Prisma.Decimal(input.amount),
        expense_date: expenseDate,
        description: input.description ?? null,
        vendor: input.vendor ?? null,
        receipt_url: input.receipt_url ?? null,
        created_by: ownerId,
      },
      include: { unit: true },
    });
    // Drop the matching MONTHLY snapshot so the next /api/reports call
    // recomputes (and picks up the brand-new expense row). Best-effort:
    // a failed invalidation just means the user sees a stale PDF until
    // the next cache-miss rebuild.
    const monthKey = `${expenseDate.getUTCFullYear()}-${String(
      expenseDate.getUTCMonth() + 1,
    ).padStart(2, "0")}`;
    // Drop both the monthly snapshot for this month and the yearly
    // snapshot for this year — expenses change yearly totals too, so
    // a stale YEARLY snapshot would hide the new amount.
    await invalidateReportSnapshotsForHouse(input.house_id, {
      monthKey,
      yearKey: monthKey.slice(0, 4),
    });
    return NextResponse.json({ data: serializeExpense(created) }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 },
    );
  }
}
