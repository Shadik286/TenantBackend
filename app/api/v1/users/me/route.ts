import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const user = await prisma.user.findUnique({
    where: { id: guard.userId },
    select: {
      id: true,
      email: true,
      full_name: true,
      phone: true,
      is_verified: true,
      is_active: true,
      created_at: true,
      updated_at: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  return NextResponse.json({ data: user });
}

export async function PATCH(request: Request) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const body = (await request.json().catch(() => null)) as {
    full_name?: unknown;
    phone?: unknown;
  } | null;

  const data: { full_name?: string; phone?: string | null } = {};
  if (typeof body?.full_name === "string") {
    const name = body.full_name.trim();
    if (name.length === 0) {
      return NextResponse.json(
        { error: "full_name cannot be empty." },
        { status: 400 }
      );
    }
    data.full_name = name;
  }
  if (typeof body?.phone === "string") {
    const phone = body.phone.replace(/[^\d+]/g, "");
    if (phone.length > 0 && phone.replace(/[^\d]/g, "").length < 8) {
      return NextResponse.json(
        { error: "phone number looks too short." },
        { status: 400 }
      );
    }
    data.phone = phone.length > 0 ? phone : null;
  } else if (body?.phone === null) {
    data.phone = null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No updatable fields provided." },
      { status: 400 }
    );
  }

  try {
    const updated = await prisma.user.update({
      where: { id: guard.userId },
      data,
      select: {
        id: true,
        email: true,
        full_name: true,
        phone: true,
        is_verified: true,
      },
    });
    return NextResponse.json({ data: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to update profile.", details: message },
      { status: 500 }
    );
  }
}