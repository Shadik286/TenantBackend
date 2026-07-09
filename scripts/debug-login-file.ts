import { writeFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";

const OUT = "E:\\Tenant\\TenantManagementBackend\\debug-out.txt";

function log(line: string) {
  writeFileSync(OUT, (prev => prev + line + "\n")(""), { flag: "a" });
}

async function main() {
  // Truncate
  writeFileSync(OUT, "");
  const email = process.argv[2] ?? "testing1@gmail.com";
  const password = process.argv[3] ?? "testing1@gmail.com";
  log("email: " + email);
  log("password: " + JSON.stringify(password));
  try {
    const normalized = email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      log("RESULT: no user found for " + normalized);
      return;
    }
    log("user.id: " + user.id);
    log("user.email: " + user.email);
    const hash = user.password_hash ?? "";
    log("hash.starts_with: " + hash.slice(0, 10));
    log("hash.length: " + hash.length);
    const ok = await bcrypt.compare(password, hash);
    log("bcrypt.compare(live): " + ok);
    const fresh = await bcrypt.hash(password, 10);
    log("fresh.starts_with: " + fresh.slice(0, 10));
    log("fresh.equals(stored): " + (fresh === hash));
  } catch (err) {
    log("ERR: " + (err instanceof Error ? err.stack : String(err)));
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main();
