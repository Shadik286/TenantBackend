// One-shot script to apply pending Prisma migrations to the local DB.
// Run with: npx tsx scripts/apply-pending-migrations.ts
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();

async function main() {
  // 1. Inspect current schema.
  const cols: Array<{ column_name: string }> = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Tenant'
  `;
  console.log("Current Tenant columns:", cols.map((c) => c.column_name).join(", "));

  // 2. Find which migrations were applied.
  const applied: Array<{ migration_name: string }> = await prisma.$queryRaw`
    SELECT migration_name FROM _prisma_migrations ORDER BY started_at
  `;
  const appliedSet = new Set(applied.map((a) => a.migration_name));
  console.log("Applied:", [...appliedSet].join(", "));

  // 3. List all migration folders.
  const dir = join(process.cwd(), "prisma", "migrations");
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  console.log("On disk:", folders.join(", "));

  // 4. Apply each pending migration.
  for (const name of folders) {
    if (appliedSet.has(name)) continue;
    const sqlPath = join(dir, name, "migration.sql");
    let sql: string;
    try {
      sql = readFileSync(sqlPath, "utf8");
    } catch {
      console.log(`Skipping ${name} (no migration.sql)`);
      continue;
    }
    console.log(`\n=== Applying ${name} ===\n${sql}\n`);
    try {
      await prisma.$executeRawUnsafe(sql);
      await prisma.$executeRaw`
        INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, started_at, applied_steps_count)
        VALUES (${name}, ${"0"}, ${name}, NOW(), NOW(), 1)
      `;
      console.log(`OK: ${name}`);
    } catch (e: any) {
      console.error(`FAIL: ${name} -> ${e.message}`);
      process.exit(1);
    }
  }

  // 5. Verify final schema.
  const colsAfter: Array<{ column_name: string }> = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Tenant'
  `;
  console.log("\nFinal Tenant columns:", colsAfter.map((c) => c.column_name).join(", "));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());