import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

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

/**
 * Loads a single payment ensuring it belongs to one of the caller's houses.
 * Returns `null` when the row is missing or not owner-scoped (so callers can
 * surface a 404 without leaking existence).
 */
async function loadOwnedPayment(paymentId: string, ownerId: string) {
  return prisma.payment.findFirst({
    where: {
      id: paymentId,
      rent_charge: { house: { owner_id: ownerId, deleted_at: null } },
    },
    include: {
      rent_charge: {
        include: { unit: true, tenant: true, house: true },
      },
    },
  });
}

const PatchPaymentSchema = z.object({
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? v : v.toString()))
    .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
      message: "amount must be a non-negative number",
    })
    .optional(),
  date_paid: z.string().min(1).optional(),
  method: z
    .enum(["CASH", "BANK_TRANSFER", "MOBILE_MONEY", "CHEQUE", "CARD", "OTHER"])
    .optional(),
  reference_no: z.string().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(["CONFIRMED", "VOIDED", "REFUNDED"]).optional(),
  void_reason: z.string().max(2000).nullable().optional(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { paymentId } = await context.params;

  const payment = await loadOwnedPayment(paymentId, ownerId);
  if (!payment) {
    return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ data: serializePayment(payment) });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { paymentId } = await context.params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = PatchPaymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 },
    );
  }

  const payment = await loadOwnedPayment(paymentId, ownerId);
  if (!payment) {
    return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
  }

  const input = parsed.data;
  const data: Record<string, any> = {};
  if (input.amount !== undefined) data.amount = new Prisma.Decimal(input.amount);
  if (input.date_paid !== undefined) {
    const dt = new Date(input.date_paid);
    if (Number.isNaN(dt.getTime())) {
      return NextResponse.json(
        { error: "INVALID_DATE", message: "date_paid is not a valid ISO date" },
        { status: 400 },
      );
    }
    data.date_paid = dt;
  }
  if (input.method !== undefined) data.method = input.method;
  if (input.reference_no !== undefined) data.reference_no = input.reference_no;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.status !== undefined) {
    data.status = input.status;
    if (input.status === "VOIDED" && !payment.voided_at) {
      data.voided_at = new Date();
    }
  }
  if (input.void_reason !== undefined) data.void_reason = input.void_reason;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.payment.update({
        where: { id: paymentId },
        data,
        include: {
          rent_charge: {
            include: { unit: true, tenant: true, house: true },
          },
        },
      });

      // Recompute the parent charge's status from CONFIRMED payments only.
      // VOIDED/REFUNDED rows don't count toward the balance.
      const chargeId = next.rent_charge_id;
      const charge = await tx.rentCharge.findUnique({ where: { id: chargeId } });
      if (charge) {
        const agg = await tx.payment.aggregate({
          where: { rent_charge_id: chargeId, status: "CONFIRMED" },
          _sum: { amount: true },
        });
        const paid = agg._sum.amount ?? new Prisma.Decimal(0);
        let nextStatus: "PAID" | "PARTIAL" | "UNPAID" = "UNPAID";
        if (paid.gte(charge.amount_due)) {
          nextStatus = "PAID";
        } else if (paid.gt(0)) {
          nextStatus = "PARTIAL";
        }
        if (charge.status !== nextStatus) {
          await tx.rentCharge.update({
            where: { id: chargeId },
            data: { status: nextStatus },
          });
        }
      }
      return next;
    });

    return NextResponse.json({ data: serializePayment(updated) });
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
  context: { params: Promise<{ paymentId: string }> },
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;
  const { paymentId } = await context.params;

  const payment = await loadOwnedPayment(paymentId, ownerId);
  if (!payment) {
    return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
  }

  // Soft-void instead of hard-deleting. Financial records must be append-only
  // (per architecture doc), so we mark VOIDED + set the timestamp + recompute
  // the parent charge's balance in the same transaction.
  try {
    const result = await prisma.$transaction(async (tx) => {
      const voided = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: "VOIDED",
          voided_at: new Date(),
          void_reason: "DELETED_BY_USER",
        },
      });

      const chargeId = voided.rent_charge_id;
      const charge = await tx.rentCharge.findUnique({ where: { id: chargeId } });
      if (charge) {
        const agg = await tx.payment.aggregate({
          where: { rent_charge_id: chargeId, status: "CONFIRMED" },
          _sum: { amount: true },
        });
        const paid = agg._sum.amount ?? new Prisma.Decimal(0);
        let nextStatus: "PAID" | "PARTIAL" | "UNPAID" = "UNPAID";
        if (paid.gte(charge.amount_due)) {
          nextStatus = "PAID";
        } else if (paid.gt(0)) {
          nextStatus = "PARTIAL";
        }
        if (charge.status !== nextStatus) {
          await tx.rentCharge.update({
            where: { id: chargeId },
            data: { status: nextStatus },
          });
        }
      }
      return voided;
    });

    return NextResponse.json({
      data: { id: result.id, voided: true, voided_at: result.voided_at },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 },
    );
  }
}