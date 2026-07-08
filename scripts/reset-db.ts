/**
 * Wipe every user-data table in the database. Use this in development when
 * you want a clean slate. Plan rows are preserved so the FREE/PRO plans the
 * app relies on stay seeded.
 *
 * Run with: npm run db:reset
 */
import { prisma } from "../lib/prisma";

const TABLES_IN_DELETE_ORDER = [
  // Children of leases/units/houses go first so foreign keys stay happy even
  // without ON DELETE CASCADE everywhere.
  "Payment",
  "RentCharge",
  "RentRate",
  "Lease",
  "TenantFamilyMember",
  "Attachment",
  "Tenant",
  "Expense",
  "OtherIncome",
  "Unit",
  "ReportSnapshot",
  "House",
  "Subscription",
  "AuditLog",
  "User",
] as const;

async function main() {
  for (const table of TABLES_IN_DELETE_ORDER) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegate = (prisma as any)[table[0].toLowerCase() + table.slice(1)];
    if (delegate && typeof delegate.deleteMany === "function") {
      const result = await delegate.deleteMany({});
      console.log(`${table}: deleted ${result.count} row(s)`);
    } else {
      console.warn(`${table}: no Prisma delegate found, skipping`);
    }
  }
  console.log("All user-data tables cleared.");
}

main()
  .catch((err) => {
    console.error("ERR:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });