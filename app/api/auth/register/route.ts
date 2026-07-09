import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Probe-grade diagnostics: any uncaught module-load or handler error is  
// surfaced in the JSON body so smoke tests stop seeing empty 500s from    
// Vercel's edge before our code runs.

// Default FREE-plan settings applied at registration time. These match the
// values inserted by `prisma/seed.ts` and are used only as a safety net if
// the seed has not yet run (e.g. fresh CI environment).
const FREE_TRIAL_DAYS = 14;

// Strip spaces/dashes/parentheses so "+212 6 12 34 56 78" and "00212612345678"
// both become "00212612345678" before storage and lookup.
function normalizePhone(input: string): string {
  return input.replace(/[^\d+]/g, "");
}

export async function POST(request: Request) {
  try {
    return await handleRegister(request);
  } catch (err) {
    const message =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // eslint-disable-next-line no-console
    console.error("[register] uncaught:", message);
    return NextResponse.json(
      { error: "Unhandled register error.", message },
      { status: 500 }
    );
  }
}

async function handleRegister(request: Request) {
  const body = await request.json();
  const { email, password, fullName, phone } = body as {
    email?: string;
    password?: string;
    fullName?: string;
    phone?: string | null;
  };

  if (!email || !password || !fullName) {
    return NextResponse.json(
      { error: "email, password, and fullName are required." },
      { status: 400 }
    );
  }

  // Basic format check. Anything stricter belongs in a dedicated validator;
  // for now this exists purely to catch obvious bugs (e.g. registering with
  // "test5" instead of "test5@example.com").
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: "email must be a valid email address." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const normalizedEmail = email.toLowerCase();
  const normalizedPhone =
    typeof phone === "string" && phone.trim().length > 0
      ? normalizePhone(phone.trim())
      : null;

  if (normalizedPhone) {
    // At minimum 8 digits (loose; covers local short codes and full intl).
    const digitsOnly = normalizedPhone.replace(/[^\d]/g, "");
    if (digitsOnly.length < 8) {
      return NextResponse.json(
        { error: "phone number looks too short." },
        { status: 400 }
      );
    }
  }

  const existingEmail = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });
  if (existingEmail) {
    return NextResponse.json({ error: "Email already in use." }, { status: 409 });
  }

  if (normalizedPhone) {
    const existingPhone = await prisma.user.findUnique({
      where: { phone: normalizedPhone },
    });
    if (existingPhone) {
      return NextResponse.json(
        { error: "Phone number already in use." },
        { status: 409 }
      );
    }
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Locate the FREE plan. If the seed hasn't been run yet (or the plan was
      // deleted), fall back to looking it up by name; if that also fails we
      // surface a 500 with a clear message rather than creating a user with no
      // subscription.
      const freePlan = await tx.plan.findUnique({ where: { name: "FREE" } });
      if (!freePlan) {
        throw new Error(
          "FREE plan is missing. Run `npm run db:seed` before registering users."
        );
      }

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          password_hash: passwordHash,
          full_name: fullName,
          phone: normalizedPhone,
        },
      });

      // Every new user starts on the FREE plan with a 14-day trial window so
      // they can use the product before being asked to pay.
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setDate(periodEnd.getDate() + FREE_TRIAL_DAYS);

      await tx.subscription.create({
        data: {
          user_id: user.id,
          plan_id: freePlan.id,
          status: "TRIALING",
          current_period_start: now,
          current_period_end: periodEnd,
        },
      });

      return user;
    });

    return NextResponse.json(
      {
        data: {
          id: result.id,
          email: result.email,
          phone: result.phone,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // We don't know which unique field tripped without inspecting meta; the
      // most likely candidates are email or phone, both already checked above,
      // so we surface a generic conflict.
      return NextResponse.json(
        { error: "An account with these credentials already exists." },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to create user.", message },
      { status: 500 }
    );
  }
}
