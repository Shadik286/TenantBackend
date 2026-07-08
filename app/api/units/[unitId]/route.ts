import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";

// Soft-delete a unit + terminate its active leases. Edit monthly rent by
// opening a new RentRate row and closing the previous one in the same tx.

const PatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    floor: z.string().max(40).nullable().optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    bathrooms: z.number().int().min(0).max(20).optional(),
    description: z.string().max(2000).nullable().optional(),
    monthly_rent: z
      .union([z.string(), z.number()])
      .transform((v) => (typeof v === "string" ? v : v.toString()))
      .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
        message: "monthly_rent must be a non-negative number",
      })
      .optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required.",
  });

async function loadOwnedUnit(unitId: string, ownerId: string) {
  return prisma.unit.findFirst({
    where: {
      id: unitId,
      deleted_at: null,
      house: { owner_id: ownerId, deleted_at: null },
    },
    include: {
      house: { select: { id: true, owner_id: true, deleted_at: true } },
    },
  });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ unitId: string }> }
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const { unitId } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 }
    );
  }

  const unit = await loadOwnedUnit(unitId, ownerId);
  if (!unit) {
    return NextResponse.json({ error: "UNIT_NOT_FOUND" }, { status: 404 });
  }

  const data = parsed.data;
  const unitPatch: Prisma.UnitUncheckedUpdateInput = {};
  if (data.name !== undefined) unitPatch.name = data.name;
  if (data.floor !== undefined) unitPatch.floor = data.floor ?? null;
  if (data.bedrooms !== undefined) unitPatch.bedrooms = data.bedrooms;
  if (data.bathrooms !== undefined) unitPatch.bathrooms = data.bathrooms;
  if (data.description !== undefined)
    unitPatch.description = data.description ?? null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.unit.update({
        where: { id: unitId },
        data: unitPatch,
      });

      let currentRate: { id: string; amount: Prisma.Decimal } | null = null;
      if (data.monthly_rent !== undefined) {
        const previousOpen = await tx.rentRate.findFirst({
          where: { unit_id: unitId, effective_to: null },
          orderBy: { effective_from: "desc" },
        });
        if (previousOpen) {
          await tx.rentRate.update({
            where: { id: previousOpen.id },
            data: { effective_to: new Date() },
          });
        }
        const newRate = await tx.rentRate.create({
          data: {
            unit_id: unitId,
            amount: new Prisma.Decimal(data.monthly_rent),
            effective_from: new Date(),
            effective_to: null,
            set_by: ownerId,
          },
        });
        currentRate = { id: newRate.id, amount: newRate.amount };
      } else {
        const existing = await tx.rentRate.findFirst({
          where: { unit_id: unitId, effective_to: null },
          orderBy: { effective_from: "desc" },
        });
        if (existing) {
          currentRate = { id: existing.id, amount: existing.amount };
        }
      }

      return { updated, currentRate };
    });

    return NextResponse.json({
      unit: {
        id: result.updated.id,
        house_id: result.updated.house_id,
        name: result.updated.name,
        floor: result.updated.floor,
        bedrooms: result.updated.bedrooms,
        bathrooms: result.updated.bathrooms,
        description: result.updated.description,
        monthly_rent: result.currentRate
          ? Number(result.currentRate.amount)
          : null,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ unitId: string }> }
) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;
  const ownerId = guard.userId;

  const { unitId } = await context.params;
  const unit = await loadOwnedUnit(unitId, ownerId);
  if (!unit) {
    return NextResponse.json({ error: "UNIT_NOT_FOUND" }, { status: 404 });
  }

  // Refuse to delete a unit that still has an active lease - the owner
  // should reassign or terminate the tenant first. Prevents accidental
  // loss of rent history.
  const activeLease = await prisma.lease.findFirst({
    where: { unit_id: unitId, status: "ACTIVE", ended_reason: null },
  });
  if (activeLease) {
    return NextResponse.json(
      {
        error: "UNIT_HAS_ACTIVE_LEASE",
        message:
          "This unit is currently rented. End the active lease before deleting it.",
      },
      { status: 409 }
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.unit.update({
        where: { id: unitId },
        data: { deleted_at: new Date() },
      });
      await tx.rentRate.updateMany({
        where: { unit_id: unitId, effective_to: null },
        data: { effective_to: new Date() },
      });
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 }
    );
  }
}