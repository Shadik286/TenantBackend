import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/require-user";

export const runtime = "nodejs";

const DEFAULTS = {
  notifications: "all",
  language: "en-US",
  appearance: "system",
  currency: "MAD",
  timezone: "UTC",
};

const NOTIFICATIONS = new Set(["all", "important", "none"]);
const LANGUAGES = new Set(["en-US", "fr-FR", "ar-MA"]);
const APPEARANCES = new Set(["light", "dark", "system"]);
const CURRENCIES = new Set(["USD", "EUR", "MAD", "GBP"]);

function validatePatch(
  patch: Record<string, unknown>
): { ok: true; data: Record<string, string> } | { ok: false; error: string } {
  const data: Record<string, string> = {};

  if ("notifications" in patch) {
    const v = String(patch.notifications ?? "");
    if (!NOTIFICATIONS.has(v)) {
      return { ok: false, error: "notifications must be one of all|important|none" };
    }
    data.notifications = v;
  }
  if ("language" in patch) {
    const v = String(patch.language ?? "");
    if (!LANGUAGES.has(v)) {
      return { ok: false, error: "language must be one of en-US|fr-FR|ar-MA" };
    }
    data.language = v;
  }
  if ("appearance" in patch) {
    const v = String(patch.appearance ?? "");
    if (!APPEARANCES.has(v)) {
      return { ok: false, error: "appearance must be one of light|dark|system" };
    }
    data.appearance = v;
  }
  if ("currency" in patch) {
    const v = String(patch.currency ?? "");
    if (!CURRENCIES.has(v)) {
      return { ok: false, error: "currency must be one of USD|EUR|MAD|GBP" };
    }
    data.currency = v;
  }
  if ("timezone" in patch) {
    const v = String(patch.timezone ?? "");
    if (v.length < 1 || v.length > 64) {
      return { ok: false, error: "timezone looks invalid" };
    }
    data.timezone = v;
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, error: "No updatable preference fields provided." };
  }

  return { ok: true, data };
}

export async function GET() {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  let prefs = await prisma.userPreference.findUnique({
    where: { user_id: guard.userId },
  });

  if (!prefs) {
    prefs = await prisma.userPreference.create({
      data: { user_id: guard.userId, ...DEFAULTS },
    });
  }

  return NextResponse.json({
    data: {
      notifications: prefs.notifications,
      language: prefs.language,
      appearance: prefs.appearance,
      currency: prefs.currency,
      timezone: prefs.timezone,
      updated_at: prefs.updated_at,
    },
  });
}

export async function PATCH(request: Request) {
  const guard = await requireUserId();
  if ("response" in guard) return guard.response;

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validated = validatePatch(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  // Make sure the row exists before we update so a fresh user doesn't 404.
  await prisma.userPreference.upsert({
    where: { user_id: guard.userId },
    update: validated.data,
    create: { user_id: guard.userId, ...DEFAULTS, ...validated.data },
  });

  const prefs = await prisma.userPreference.findUnique({
    where: { user_id: guard.userId },
  });

  return NextResponse.json({ data: prefs });
}