// Coupon admin. Create, list and deactivate codes from the command line.
//
//   npx tsx scripts/coupons.ts create --type FREE_PRO --days 30 --max 100
//   npx tsx scripts/coupons.ts create --type TRIAL_EXTENSION --days 14 --code LAUNCH2026
//   npx tsx scripts/coupons.ts list
//   npx tsx scripts/coupons.ts deactivate K7QF2M9XTD
//
// There is deliberately no admin HTTP endpoint yet. Coupons mint free PRO, so
// the blast radius of an auth mistake on that endpoint is "anyone can print
// money" — a CLI that needs the database URL is a smaller target, and this is
// a handful of codes a quarter, not a workflow.
import { PrismaClient, CouponType } from "@prisma/client";
import { randomInt } from "crypto";

const prisma = new PrismaClient();

// Crockford-ish base32: no 0/O/1/I/L/U. Removes the characters people
// mistranscribe off a printed code, and drops U so the generator cannot
// accidentally spell something unfortunate.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** 10 characters over a 30-symbol alphabet ~= 49 bits. */
const CODE_LENGTH = 10;

/**
 * Generate a code with real entropy.
 *
 * `randomInt` is the CSPRNG, not `Math.random`: a coupon namespace that can be
 * predicted from a seed is a namespace that can be walked offline, and these
 * grant PRO for free. Rejection-free because randomInt takes an exclusive
 * bound, so there is no modulo bias to worry about.
 */
function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** Printed form: groups of 4, which people transcribe far more reliably.
 *  The redeem endpoint strips dashes, so either form is accepted. */
function pretty(code: string): string {
  return (code.match(/.{1,4}/g) ?? [code]).join("-");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function create() {
  const typeRaw = (arg("type") ?? "FREE_PRO").toUpperCase();
  if (typeRaw !== "FREE_PRO" && typeRaw !== "TRIAL_EXTENSION") {
    throw new Error("--type must be FREE_PRO or TRIAL_EXTENSION");
  }
  const type = typeRaw as CouponType;

  const days = Number(arg("days"));
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("--days must be a positive integer");
  }

  const maxRaw = arg("max");
  const maxRedemptions = maxRaw === undefined ? null : Number(maxRaw);
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0)) {
    throw new Error("--max must be a positive integer, or omitted for unlimited");
  }

  const untilRaw = arg("until");
  const validUntil = untilRaw ? new Date(untilRaw) : null;
  if (validUntil && Number.isNaN(validUntil.getTime())) {
    throw new Error("--until must be a date, e.g. 2026-12-31");
  }

  // A hand-picked code is allowed for printed campaigns, but it skips the
  // entropy the generator provides — so say so rather than let it pass
  // silently.
  const custom = arg("code");
  const code = custom ? custom.trim().toUpperCase().replace(/[\s-]+/g, "") : generateCode();
  if (custom) {
    console.warn(
      `! Custom code "${code}" has no guaranteed entropy. Fine for a short\n` +
        `  campaign with a redemption cap; do not use it for an unlimited\n` +
        `  FREE_PRO coupon.`,
    );
  }

  const coupon = await prisma.coupon.create({
    data: {
      code,
      type,
      value_days: days,
      max_redemptions: maxRedemptions,
      valid_until: validUntil,
    },
  });

  console.log("Created coupon");
  console.log(`  code    ${pretty(coupon.code)}   (enter as ${coupon.code})`);
  console.log(`  type    ${coupon.type}`);
  console.log(`  grants  ${coupon.value_days} days`);
  console.log(`  max     ${coupon.max_redemptions ?? "unlimited"}`);
  console.log(`  until   ${coupon.valid_until?.toISOString() ?? "no expiry"}`);
}

async function list() {
  const coupons = await prisma.coupon.findMany({
    orderBy: { created_at: "desc" },
    include: { _count: { select: { redemptions: true } } },
  });
  if (coupons.length === 0) {
    console.log("No coupons.");
    return;
  }
  for (const c of coupons) {
    const cap = c.max_redemptions ?? "∞";
    const state = c.is_active ? "active" : "INACTIVE";
    console.log(
      `${pretty(c.code).padEnd(14)} ${c.type.padEnd(16)} ${String(c.value_days).padStart(3)}d  ` +
        `${c._count.redemptions}/${cap}  ${state}`,
    );
  }
}

async function deactivate() {
  const raw = process.argv[3];
  if (!raw) throw new Error("Usage: deactivate <CODE>");
  const code = raw.trim().toUpperCase().replace(/[\s-]+/g, "");

  // Deactivate rather than delete: the redemption rows reference it, and
  // anyone who already redeemed keeps their grant. Pulling the row would
  // revoke a promise we already made.
  const updated = await prisma.coupon.updateMany({
    where: { code },
    data: { is_active: false },
  });
  console.log(
    updated.count === 1 ? `Deactivated ${pretty(code)}.` : `No coupon ${pretty(code)}.`,
  );
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "create":
      await create();
      break;
    case "list":
      await list();
      break;
    case "deactivate":
      await deactivate();
      break;
    default:
      console.log(
        "Usage:\n" +
          "  coupons.ts create --type FREE_PRO|TRIAL_EXTENSION --days N [--max N] [--until YYYY-MM-DD] [--code CODE]\n" +
          "  coupons.ts list\n" +
          "  coupons.ts deactivate <CODE>",
      );
      process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
