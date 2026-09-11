import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { invalidateReportSnapshotsForHouse } from "@/lib/report-cache";
import {
  notifyTenant,
  paymentReceiptDedupeKey,
} from "@/lib/notifications";

export const runtime = "nodejs";

/**
 * Serializes a Payment row joined with its RentCharge so the Flutter
 * Finances tab can render "{date, unit, tenant, status, amount}" without
 * an extra round trip per row. Computes the UI amount as a JS number
 * because the same string is what Flutter expects.
 *
 * Status derivation:
 *   - If the payment is VOIDED, surface that literal label.
 *   - Otherwise surface the CHARGE status (PAID / PARTIAL / UNPAID) so
 *     the row reflects "is this charge settled?" not the payment row
 *     state, which is mostly CONFIRMED by default.
 */
function serializePayment(p: any) {
  const charge = p.rent_charge ?? null;
  const unit = charge?.unit ?? null;
  const tenant = charge?.tenant ?? null;
  const amount = Number(p.amount ?? "0");
  const chargeStatus = charge?.status ?? null;
  const status =
    p.status === "VOIDED"
      ? "voided"
      : p.status === "REFUNDED"
        ? "refunded"
        : (chargeStatus ?? "confirmed").toString().toLowerCase();
  return {
    id: p.id,
    rent_charge_id: p.rent_charge_id,
    amount,
    currency: "USD",
    date_paid: p.date_paid,
    method: p.method,
    status,
    reference_no: p.reference_no ?? null,
    notes: p.notes ?? null,
    void_reason: p.void_reason ?? null,
    voided_at: p.voided_at ?? null,
    idempotency_key: p.idempotency_key ?? null,
    recorded_by: p.recorded_by,
    created_at: p.created_at,
    updated_at: p.updated_at,
    // Flatten the join so the Flutter card can render directly.
    due_month: charge?.due_month ?? null,
    due_date: charge?.due_date ?? null,
    amount_due: charge ? Number(charge.amount_due ?? "0") : null,
    unit_id: charge?.unit_id ?? null,
    unit_name: unit?.name ?? null,
    house_id: charge?.house_id ?? null,
    tenant_id: charge?.tenant_id ?? null,
    tenant_name: tenant?.full_name ?? null,
  };
}

const CreatePaymentSchema = z
  .object({
    // Legacy / explicit path: caller already resolved a RentCharge.
    rent_charge_id: z.string().uuid().optional(),
    // "Simple" path: caller only has the unit + tenant + month. The route
    // resolves (or creates) the month's RentCharge inline. Useful when the
    // landlord wants to record a payment without first running the bulk
    // generate-monthly-charges endpoint.
    unit_id: z.string().uuid().optional(),
    tenant_id: z.string().uuid().optional(),
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format")
      .optional(),
    amount: z
      .union([z.string(), z.number()])
      .transform((v) => (typeof v === "string" ? v : v.toString()))
      .refine((v) => !Number.isNaN(Number(v)) && Number(v) > 0, {
        message: "amount must be a positive number",
      }),
    date_paid: z.string().min(1),
    method: z.enum([
      "CASH",
      "BANK_TRANSFER",
      "MOBILE_MONEY",
      "CHEQUE",
      "CARD",
      "OTHER",
    ]),
    reference_no: z.string().max(120).optional(),
    notes: z.string().max(2000).optional(),
    idempotency_key: z.string().max(120).optional(),
  })
  .refine(
    (v) => Boolean(v.rent_charge_id) || (Boolean(v.unit_id) && Boolean(v.tenant_id)),
    {
      message:
        "Either rent_charge_id OR (unit_id + tenant_id) must be provided.",
      path: ["rent_charge_id"],
    },
  );

/**
 * Loads payments scoped to the caller's houses. Accepts:
 *   - houseId: filter to one house
 *   - month:   "YYYY-MM" — applied via the charge's due_month
 *
 * Hidden rows (`voided_at IS NULL` on the join table is irrelevant here —
 * we hide VOIDED/REFUNDED payments explicitly) are excluded so the Finances
 * screen only sees payments that count toward the month totals.
 */
export async function GET(request: NextRequest) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const sp = request.nextUrl.searchParams;
  const houseId = sp.get("houseId");
  const month = sp.get("month"); // YYYY-MM

  // Cap at 200 rows. The Finances tab never renders more than a few
  // dozen at a time, so 200 is a generous safety net that keeps the
  // JSON payload under ~100 KB. Clients that need more can paginate.
  const take = Math.min(
    Math.max(Number(sp.get("take")) || 200, 1),
    500,
  );

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ["CONFIRMED", "VOIDED"] },
      rent_charge: {
        house: {
          owner_id: ownerId,
          deleted_at: null,
          ...(houseId ? { id: houseId } : {}),
        },
        ...(month ? { due_month: month } : {}),
      },
    },
    orderBy: { date_paid: "desc" },
    take,
    // Explicit `select` instead of `include` so we don't ship the
    // unused `house` row (the calling code only reads unit/tenant
    // names from the charge) and we don't fetch internal `unit.notes`
    // or other heavy columns.
    select: {
      id: true,
      rent_charge_id: true,
      amount: true,
      date_paid: true,
      method: true,
      status: true,
      reference_no: true,
      notes: true,
      void_reason: true,
      voided_at: true,
      idempotency_key: true,
      recorded_by: true,
      created_at: true,
      updated_at: true,
      rent_charge: {
        select: {
          due_month: true,
          due_date: true,
          amount_due: true,
          unit_id: true,
          house_id: true,
          tenant_id: true,
          unit: { select: { id: true, name: true } },
          tenant: { select: { id: true, full_name: true } },
        },
      },
    },
  });

  // Totals: confirmed-only contribution. VOIDED payments are returned in
  // the list (so the UI can show them greyed/strikethrough) but excluded
  // from `income_total`.
  let incomeTotal = new Prisma.Decimal(0);
  let count = 0;
  for (const p of payments) {
    if (p.status === "CONFIRMED") {
      incomeTotal = incomeTotal.add(p.amount);
      count += 1;
    }
  }

  return NextResponse.json({
    data: payments.map(serializePayment),
    summary: {
      income_total: incomeTotal.toFixed(2),
      payments_count: count,
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
  const parsed = CreatePaymentSchema.safeParse(body);
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

  // Resolve the target RentCharge. Two supported paths:
  //   (a) explicit: rent_charge_id provided — must exist on a house owned by
  //       the caller.
  //   (b) simple:   unit_id + tenant_id (+ optional month) provided — we find
  //       the ACTIVE lease, then find-or-create the month's RentCharge.
  type ResolvedCharge = {
    id: string;
    house_id: string;
    unit_id: string;
    lease_id: string;
    tenant_id: string;
    due_month: string;
    due_date: Date;
    amount_due: Prisma.Decimal;
    status: string;
  };
  let charge: ResolvedCharge | null = null;

  if (input.rent_charge_id) {
    const found = await prisma.rentCharge.findFirst({
      where: {
        id: input.rent_charge_id,
        house: { owner_id: ownerId, deleted_at: null },
      },
    });
    if (!found) {
      return NextResponse.json(
        { error: "RENT_CHARGE_NOT_FOUND" },
        { status: 404 },
      );
    }
    // Same guard as the simple path: don't accept a payment against a charge
    // that's already fully paid.
    const paidAgg = await prisma.payment.aggregate({
      where: {
        rent_charge_id: found.id,
        status: "CONFIRMED",
      },
      _sum: { amount: true },
    });
    const alreadyPaid = paidAgg._sum.amount ?? new Prisma.Decimal(0);
    const dueAmount = new Prisma.Decimal(found.amount_due ?? 0);
    if (alreadyPaid.gte(dueAmount) && !dueAmount.isZero()) {
      return NextResponse.json(
        {
          error: "MONTH_ALREADY_PAID",
          message: `Rent for ${found.due_month} is already fully paid for this tenant+unit.`,
          rent_charge_id: found.id,
          paid_amount: alreadyPaid.toFixed(2),
          amount_due: dueAmount.toFixed(2),
        },
        { status: 409 },
      );
    }
    charge = found as ResolvedCharge;
  } else {
    // Simple path: caller only has the unit + tenant. We find the ACTIVE
    // lease (scoped to caller's houses), then find-or-create the month's
    // RentCharge. If the unit has no RentRate yet, the payment amount
    // itself is used as amount_due — the user is recording what they
    // actually received.
    const lease = await prisma.lease.findFirst({
      where: {
        unit_id: input.unit_id!,
        tenant_id: input.tenant_id!,
        status: "ACTIVE",
        house: { owner_id: ownerId, deleted_at: null },
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
    if (!lease) {
      return NextResponse.json(
        {
          error: "ACTIVE_LEASE_NOT_FOUND",
          message:
            "No active lease for this tenant+unit on any of your houses.",
        },
        { status: 404 },
      );
    }
    const amountDecimalEarly = new Prisma.Decimal(input.amount);
    const month =
      input.month ?? new Date(input.date_paid).toISOString().slice(0, 7);
    const dueDate = new Date(`${month}-01T00:00:00.000Z`);
    const rate = lease.unit.rent_rates[0];

    let existing = await prisma.rentCharge.findUnique({
      where: {
        unit_id_lease_id_due_month: {
          unit_id: lease.unit_id,
          lease_id: lease.id,
          due_month: month,
        },
      },
    });
    if (!existing) {
      existing = await prisma.rentCharge.create({
        data: {
          house_id: lease.house_id,
          unit_id: lease.unit_id,
          lease_id: lease.id,
          tenant_id: lease.tenant_id,
          due_month: month,
          due_date: dueDate,
          amount_due: rate ? rate.amount : amountDecimalEarly,
          status: "UNPAID",
        },
      });
    }
    // Block double-payment: if this month's charge is already fully settled,
    // reject the request so the UI can show "already paid for {month}".
    // Sum the CONFIRMED payments already on the charge rather than trusting
    // the cached `status` field — the two can drift if a payment is voided
    // later.
    const paidAgg = await prisma.payment.aggregate({
      where: {
        rent_charge_id: existing.id,
        status: "CONFIRMED",
      },
      _sum: { amount: true },
    });
    const alreadyPaid = paidAgg._sum.amount ?? new Prisma.Decimal(0);
    const dueAmount = new Prisma.Decimal(existing.amount_due ?? 0);
    if (alreadyPaid.gte(dueAmount) && !dueAmount.isZero()) {
      return NextResponse.json(
        {
          error: "MONTH_ALREADY_PAID",
          message: `Rent for ${month} is already fully paid for this tenant+unit.`,
          rent_charge_id: existing.id,
          paid_amount: alreadyPaid.toFixed(2),
          amount_due: dueAmount.toFixed(2),
        },
        { status: 409 },
      );
    }
    charge = existing as ResolvedCharge;
  }

  const amountDecimal = new Prisma.Decimal(input.amount);
  const datePaid = new Date(input.date_paid);
  if (Number.isNaN(datePaid.getTime())) {
    return NextResponse.json(
      { error: "INVALID_DATE", message: "date_paid is not a valid ISO date" },
      { status: 400 },
    );
  }

  // Idempotency: same key returns the previously created payment instead of
  // duplicating rows. The Flutter client doesn't currently send one (it
  // doesn't have a UUID generator), but the schema enforces it, so we
  // synthesize one from the charge + datePaid + amount.
  const idemKey =
    input.idempotency_key ??
    `${charge!.id}:${datePaid.toISOString()}:${amountDecimal.toFixed(2)}`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // If a payment with this idempotency key already exists, return it.
      const existing = await tx.payment.findUnique({
        where: { idempotency_key: idemKey },
        include: {
          rent_charge: {
            include: { unit: true, tenant: true, house: true },
          },
        },
      });
      if (existing) {
        // `wasCreated: false` is what stops a retried request mailing the
        // tenant a second invoice. Without this flag the caller cannot tell an
        // idempotent replay from a genuine new payment — both return a Payment
        // row that looks identical.
        return { payment: existing, wasCreated: false as const };
      }

      const created = await tx.payment.create({
        data: {
          rent_charge_id: charge.id,
          amount: amountDecimal,
          date_paid: datePaid,
          method: input.method,
          status: "CONFIRMED",
          reference_no: input.reference_no ?? null,
          notes: input.notes ?? null,
          idempotency_key: idemKey,
          recorded_by: ownerId,
        },
        include: {
          rent_charge: {
            include: { unit: true, tenant: true, house: true },
          },
        },
      });

      // Recompute the parent charge's status based on the sum of CONFIRMED
      // payments. Paid in full -> PAID. Partial -> PARTIAL. Otherwise UNPAID.
      const agg = await tx.payment.aggregate({
        where: { rent_charge_id: charge.id, status: "CONFIRMED" },
        _sum: { amount: true },
      });
      const paid = agg._sum.amount ?? new Prisma.Decimal(0);
      let nextStatus: "PAID" | "PARTIAL" | "UNPAID" = "UNPAID";
      if (paid.gte(charge.amount_due)) {
        nextStatus = "PAID";
      } else if (paid.gt(0)) {
        nextStatus = "PARTIAL";
      }
      await tx.rentCharge.update({
        where: { id: charge.id },
        data: { status: nextStatus },
      });

      // Carry the already-computed totals out for the receipt. These are exact
      // as of this transaction; recomputing them afterwards would race with a
      // concurrent payment on the same charge and could tell the tenant a
      // balance that was never true.
      return {
        payment: created,
        wasCreated: true as const,
        paidTotal: paid,
        amountDue: charge.amount_due,
        chargeStatus: nextStatus,
      };
    });

    // Payment totals feed both the monthly and yearly reports. Invalidate
    // the matching snapshots so the next /api/reports request rebuilds
    // with the new payment included. The cache-write path is now also
    // safe: see app/api/reports/[houseId]/route.ts — the current month
    // and year never carry `is_final: true`, so an invalidate that races
    // with a concurrent GET simply drops the (non-final) snapshot.
    const invalidateMonthKey = charge!.due_month;
    const invalidateYearKey = invalidateMonthKey.slice(0, 4);
    await invalidateReportSnapshotsForHouse(charge!.house_id, {
      monthKey: invalidateMonthKey,
      yearKey: invalidateYearKey,
    });

    // Receipt to the tenant — only on a genuine creation, never on an
    // idempotent replay, and only when we actually have an address.
    if (result.wasCreated) {
      const rc = result.payment.rent_charge;
      const remaining = result.amountDue.sub(result.paidTotal);
      await notifyTenant({
        landlordUserId: ownerId,
        recipient: {
          tenantId: rc.tenant_id,
          tenantName: rc.tenant?.full_name ?? "",
          email: rc.tenant?.email ?? null,
        },
        payload: {
          kind: "PAYMENT_RECEIPT",
          amountPaid: result.payment.amount.toFixed(2),
          datePaid: result.payment.date_paid,
          method: result.payment.method,
          dueMonth: rc.due_month,
          amountDue: result.amountDue.toFixed(2),
          totalPaid: result.paidTotal.toFixed(2),
          // Floored: an overpayment must not render as a negative balance.
          remaining: (remaining.isNegative()
            ? new Prisma.Decimal(0)
            : remaining
          ).toFixed(2),
          status: result.chargeStatus,
          houseName: rc.house?.name ?? "",
          unitName: rc.unit?.name ?? "",
          referenceNo: result.payment.reference_no ?? null,
        },
        dedupeKey: paymentReceiptDedupeKey(result.payment.id),
      });
    }

    return NextResponse.json(
      { data: serializePayment(result.payment) },
      { status: 201 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 },
    );
  }
}
