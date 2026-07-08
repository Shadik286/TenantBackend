import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error("usage: npm run debug:login -- <email> <password>");
    process.exit(2);
  }

  const normalized = email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) {
    console.log("RESULT: no user found for email:", normalized);
    return;
  }

  const hash = user.password_hash;
  console.log("user.id:", user.id);
  console.log("user.email:", user.email);
  console.log("hash.starts_with:", hash.slice(0, 7));
  console.log("hash.length:", hash.length);

  const liveCompare = await bcrypt.compare(password, hash);
  console.log("bcrypt.compare(live):", liveCompare);

  const selfCompare = await bcrypt.compare(password, hash);
  console.log("bcrypt.compare(again):", selfCompare);

  // Force a fresh hash of the same password to confirm the algorithm matches
  const fresh = await bcrypt.hash(password, 10);
  console.log("fresh.starts_with:", fresh.slice(0, 7));
  console.log("fresh.equals(stored):", fresh === hash);

  // Hex-dump the password so spacing/casing/control-byte issues are visible
  const hex = Buffer.from(password, "utf8").toString("hex");
  console.log("password.length:", password.length);
  console.log("password.hex :", hex);
  console.log("password.quoted:", JSON.stringify(password));

  // Round-trip with common drift causes so you can see exactly which one matches
  const variants: Array<[string, string]> = [
    ["trimmed",         password.trim()],
    ["stripped spaces", password.replace(/\s+/g, "")],
    ["stripped all ws", password.replace(/[\s\u0000-\u001f]+/g, "")],
  ];
  for (const [label, variant] of variants) {
    if (variant === password) continue;
    const ok = await bcrypt.compare(variant, hash);
    console.log(`bcrypt.compare(${label}):`, ok);
  }
}

main()
  .catch((err) => {
    console.error("ERR:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });