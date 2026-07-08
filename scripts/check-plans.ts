import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const plans = await prisma.plan.findMany({
    select: { name: true, max_houses: true, max_units_per_house: true },
    orderBy: { name: "asc" },
  });
  console.table(plans);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
