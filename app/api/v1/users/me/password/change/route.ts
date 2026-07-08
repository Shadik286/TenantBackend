import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const body = (await request.json().catch(() => null)) as {
    current_password?: unknown;
    new_password?: unknown;
  } | null;

  const currentPassword =
    typeof body?.current_password === "string" ? body.current_password : "";
  const newPassword =
    typeof body?.new_password === "string" ? body.new_password : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "current_password and new_password are required." },
      { status: 400 }
    );
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: "new_password must be at least 8 characters." },
      { status: 400 }
    );
  }

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: "new_password must differ from current_password." },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: guard.userId },
    select: { id: true, password_hash: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const matches = await bcrypt.compare(currentPassword, user.password_hash);
  if (!matches) {
    return NextResponse.json(
      { error: "current_password is incorrect." },
      { status: 401 }
    );
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { password_hash: newHash },
  });

  return NextResponse.json({ ok: true });
}