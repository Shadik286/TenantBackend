import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { invalidateReportSnapshotsForHouse } from "@/lib/report-cache";

function monthKeyFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

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

/**
 * Soft-delete-friendly ownership check. Returns the row only if it belongs
 * to one of the caller's houses (active or soft-deleted, so DELETE flows
 * still see the row they need to mark deleted).
 */
async function loadOwnedExpense(expenseId: string, ownerId: string) {
  return prisma.expense.findFirst({
    where: {
      id: expenseId,
      house: { owner_id: ownerId },
    },
    include: { unit: true },
  });
}

const PatchExpenseSchema = z.object({
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? v : v.toString()))
    .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
      message: "amount must be a non-negative number",
    })
    .optional(),
  expense_date: z.string().min(1).optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  custom_category: z.string().max(80).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  vendor: z.string().max(120).nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  // `null` detaches the receipt; omitting the key leaves the stored one
  // untouched, so a PATCH that only changes the amount never wipes the photo.
  receipt_url: z.string().url().max(2048).nullable().optional(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ expenseId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { expenseId } = await context.params;

  const expense = await loadOwnedExpense(expenseId, ownerId);
  if (!expense || expense.deleted_at) {
    return NextResponse.json({ error: "EXPENSE_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ data: serializeExpense(expense) });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ expenseId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { expenseId } = await context.params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = PatchExpenseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 },
    );
  }

  const expense = await loadOwnedExpense(expenseId, ownerId);
  if (!expense || expense.deleted_at) {
    return NextResponse.json({ error: "EXPENSE_NOT_FOUND" }, { status: 404 });
  }

  const input = parsed.data;
  const data: Record<string, any> = {};
  if (input.amount !== undefined) data.amount = new Prisma.Decimal(input.amount);
  if (input.expense_date !== undefined) {
    const dt = new Date(input.expense_date);
    if (Number.isNaN(dt.getTime())) {
      return NextResponse.json(
        { error: "INVALID_DATE", message: "expense_date is not a valid ISO date" },
        { status: 400 },
      );
    }
    data.expense_date = dt;
  }
  if (input.category !== undefined) data.category = input.category;
  if (input.custom_category !== undefined) data.custom_category = input.custom_category;
  if (input.description !== undefined) data.description = input.description;
  if (input.vendor !== undefined) data.vendor = input.vendor;
  if (input.unit_id !== undefined) data.unit_id = input.unit_id;
  if (input.receipt_url !== undefined) data.receipt_url = input.receipt_url;

  try {
    const updated = await prisma.expense.update({
      where: { id: expenseId },
      data,
      include: { unit: true },
    });
    // Drop the snapshot for the row's old month AND the new month (if the
    // PATCH moved expense_date across a month boundary, the destination
    // month's snapshot needs to be recomputed too). Also drop the YEARLY
    // snapshot for each affected year — expenses feed yearly totals too.
    const oldKey = monthKeyFor(expense.expense_date);
    const newKey = monthKeyFor(updated.expense_date);
    const months = new Set<string>([oldKey, newKey]);
    for (const monthKey of months) {
      await invalidateReportSnapshotsForHouse(updated.house_id, {
        monthKey,
        yearKey: monthKey.slice(0, 4),
      });
    }
    return NextResponse.json({ data: serializeExpense(updated) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ expenseId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { expenseId } = await context.params;

  const expense = await loadOwnedExpense(expenseId, ownerId);
  if (!expense || expense.deleted_at) {
    return NextResponse.json({ error: "EXPENSE_NOT_FOUND" }, { status: 404 });
  }

  // Soft-delete: financial records are append-only, so we set `deleted_at`
  // rather than removing the row. GET/aggregation queries filter on
  // `deleted_at: null` to exclude them.
  try {
    const deleted = await prisma.expense.update({
      where: { id: expenseId },
      data: { deleted_at: new Date() },
    });
    // Soft-delete still affects aggregations, so drop the cached snapshot
    // for the month (and year) the row belonged to.
    const monthKey = monthKeyFor(expense.expense_date);
    await invalidateReportSnapshotsForHouse(deleted.house_id, {
      monthKey,
      yearKey: monthKey.slice(0, 4),
    });
    return NextResponse.json({
      data: { id: deleted.id, deleted: true, deleted_at: deleted.deleted_at },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 },
    );
  }
}
