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
      // Surfaced so the client can gate onboarding: a Google user with no
      // phone yet must be sent to the phone-capture step before the app
      // proper. `provider` tells the client which sign-in flow to offer on
      // sign-out, and whether the phone field is editable at all.
      provider: true,
      phone_verified: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      ...user,
      // Explicit flag rather than making every client re-derive it from a
      // null check. This is the single condition that forces phone capture.
      needs_phone: !user.phone,
    },
  });
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
  const wantsPhoneChange =
    typeof body?.phone === "string" || body?.phone === null;

  if (wantsPhoneChange) {
    // 🔒 SEC-013 — the phone number is the login identity for bdapps accounts,
    // and (from F4 onward) the key that determines subscription entitlement.
    // Letting it be changed by a plain profile PATCH would mean:
    //   * the account is orphaned — the next bdapps login finds nothing under
    //     the old number and silently creates a second, empty account; and
    //   * once entitlement is keyed on phone, editing this field edits who is
    //     paying for whom.
    //
    // Changing it must therefore require re-proving ownership by OTP. That flow
    // needs an SMS provider, which does not exist yet (plan Q11), so for now
    // bdapps accounts are simply refused.
    const actor = await prisma.user.findUnique({
      where: { id: guard.userId },
      select: { provider: true },
    });

    if (actor?.provider === "bdapps") {
      return NextResponse.json(
        {
          error: "PHONE_IMMUTABLE",
          message:
            "Your phone number is your sign-in identity and cannot be changed here.",
        },
        { status: 403 }
      );
    }
  }

  if (typeof body?.phone === "string") {
    const phone = body.phone.replace(/[^\d+]/g, "");
    if (phone.length > 0 && phone.replace(/[^\d]/g, "").length < 8) {
      return NextResponse.json(
        { error: "phone number looks too short." },
        { status: 400 }
      );
    }

    // Pre-check the unique constraint so a collision surfaces as a clean 409
    // rather than a raw P2002 bubbling up as a 500.
    if (phone.length > 0) {
      const taken = await prisma.user.findFirst({
        where: { phone, NOT: { id: guard.userId } },
        select: { id: true },
      });
      if (taken) {
        return NextResponse.json(
          {
            error: "PHONE_IN_USE",
            message: "That phone number is already linked to another account.",
          },
          { status: 409 }
        );
      }
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
        provider: true,
        phone_verified: true,
      },
    });
    return NextResponse.json({
      data: { ...updated, needs_phone: !updated.phone },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to update profile.", details: message },
      { status: 500 }
    );
  }
}