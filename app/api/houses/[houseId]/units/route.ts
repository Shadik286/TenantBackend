import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireUserId } from "@/lib/require-user";
import { prisma } from "@/lib/prisma";
import { getPlanForOwner } from "@/lib/plans/get-plan";
import { blockIfOverLimit } from "@/lib/plans/over-limit";

const CreateUnitSchema = z.object({
  name: z.string().min(1).max(80),
  monthly_rent: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? v : v.toString()))
    .refine((v) => !Number.isNaN(Number(v)) && Number(v) >= 0, {
      message: "monthly_rent must be a non-negative number",
    }),
  floor: z.string().max(40).optional(),
  bedrooms: z.number().int().min(0).max(20).optional(),
  bathrooms: z.number().int().min(0).max(20).optional(),
  description: z.string().max(2000).optional(),
});

async function requireOwnerId(): Promise<string | null> {
  // Accepts both bearer JWT (Flutter mobile) and NextAuth session cookie (web).
  const guard = await requireUserId();
  if ("response" in guard) return null;
  return guard.userId;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ houseId: string }> }
) {
  const ownerId = await requireOwnerId();
  if (!ownerId) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const { houseId } = await context.params;
  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }
  const [units, plan] = await Promise.all([
    prisma.unit.findMany({
      where: { house_id: houseId, deleted_at: null },
      orderBy: { created_at: "asc" },
      include: {
        rent_rates: {
          where: { effective_to: null },
          orderBy: { effective_from: "desc" },
          take: 1,
        },
      },
    }),
    getPlanForOwner(ownerId),
  ]);
  return NextResponse.json({
    house: { id: house.id, name: house.name },
    units: units.map((unit) => {
      const currentRate = unit.rent_rates[0];
      return {
        id: unit.id,
        name: unit.name,
        floor: unit.floor,
        bedrooms: unit.bedrooms,
        bathrooms: unit.bathrooms,
        monthly_rent: currentRate ? Number(currentRate.amount) : null,
        created_at: unit.created_at,
      };
    }),
    limits: {
      plan_name: plan.planName,
      max_units_per_house: plan.isUnlimitedUnitsPerHouse ? "unlimited" : plan.maxUnitsPerHouse,
      is_unlimited: plan.isUnlimitedUnitsPerHouse,
    },
    usage: { active_units: units.length },
  });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ houseId: string }> }
) {
  const ownerId = await requireOwnerId();
  if (!ownerId) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const { houseId } = await context.params;
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = CreateUnitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      { status: 400 }
    );
  }
  const house = await prisma.house.findFirst({
    where: { id: houseId, owner_id: ownerId, deleted_at: null },
  });
  if (!house) {
    return NextResponse.json({ error: "HOUSE_NOT_FOUND" }, { status: 404 });
  }
  // An account already over its plan cannot create anything until it is back
  // inside the limits — see lib/plans/over-limit.ts.
  const overLimit = await blockIfOverLimit(ownerId);
  if (overLimit) return overLimit;

  const plan = await getPlanForOwner(ownerId);
  const activeUnitsCount = await prisma.unit.count({
    where: { house_id: houseId, deleted_at: null },
  });
  if (!plan.isUnlimitedUnitsPerHouse && activeUnitsCount >= plan.maxUnitsPerHouse) {
    return NextResponse.json(
      {
        error: "UNIT_LIMIT_REACHED",
        code: "UNIT_LIMIT_REACHED",
        message: "Your " + plan.planName + " plan allows up to " + plan.maxUnitsPerHouse + " units per house. Upgrade to PRO for unlimited units.",
        details: {
          plan_name: plan.planName,
          max_units_per_house: plan.maxUnitsPerHouse,
          current_active_units: activeUnitsCount,
          upgrade_url: "/billing/upgrade",
        },
      },
      { status: 403 }
    );
  }
  const input = parsed.data;
  const monthlyRent = new Prisma.Decimal(input.monthly_rent);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const newUnit = await tx.unit.create({
        data: {
          house_id: houseId,
          name: input.name,
          floor: input.floor ?? null,
          bedrooms: input.bedrooms ?? 1,
          bathrooms: input.bathrooms ?? 1,
          description: input.description ?? null,
        },
      });
      await tx.rentRate.create({
        data: {
          unit_id: newUnit.id,
          amount: monthlyRent,
          effective_from: new Date(),
          effective_to: null,
          set_by: ownerId,
        },
      });
      return newUnit;
    });
    return NextResponse.json(
      {
        unit: {
          id: result.id,
          house_id: result.house_id,
          name: result.name,
          floor: result.floor,
          bedrooms: result.bedrooms,
          bathrooms: result.bathrooms,
          monthly_rent: Number(monthlyRent),
          created_at: result.created_at,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "INTERNAL_ERROR", message },
      { status: 500 }
    );
  }
}