import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  return NextResponse.json({ data: { user: guard.session.user } });
}
