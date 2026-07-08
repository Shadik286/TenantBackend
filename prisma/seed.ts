// Seeds the Plan table with two tiers so registration can hand a FREE plan to
// every new user. PRO uses very large sentinel values (Int.MAX = 2_147_483_647)
// as the practical "unlimited" marker for both houses and units per house.
// Run with: `npm run db:seed` (after `npm run db:migrate`).
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

const FREE_MAX_HOUSES = 2;
const FREE_MAX_UNITS_PER_HOUSE = 5;
const PRO_MAX_HOUSES = 2_147_483_647;
const PRO_MAX_UNITS_PER_HOUSE = 2_147_483_647;

const prisma = new PrismaClient();

async function main() {
  const plans = [
    {
      name: "FREE",
      max_houses: FREE_MAX_HOUSES,
      max_units_per_house: FREE_MAX_UNITS_PER_HOUSE,
      price_monthly: new Decimal("0"),
      features: {
        max_houses: FREE_MAX_HOUSES,
        max_units_per_house: FREE_MAX_UNITS_PER_HOUSE,
        reports: false,
        attachments: true,
      },
    },
    {
      name: "PRO",
      max_houses: PRO_MAX_HOUSES,
      max_units_per_house: PRO_MAX_UNITS_PER_HOUSE,
      price_monthly: new Decimal("29.00"),
      features: {
        max_houses: "unlimited",
        max_units_per_house: "unlimited",
        reports: true,
        attachments: true,
      },
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      create: {
        name: plan.name,
        max_houses: plan.max_houses,
        max_units_per_house: plan.max_units_per_house,
        price_monthly: plan.price_monthly,
        features: plan.features,
        is_active: true,
      },
      update: {
        max_houses: plan.max_houses,
        max_units_per_house: plan.max_units_per_house,
        price_monthly: plan.price_monthly,
        features: plan.features,
        is_active: true,
      },
    });
  }

  const total = await prisma.plan.count();
  console.log(
    `Seeded ${total} plans (FREE = ${FREE_MAX_HOUSES} houses, ${FREE_MAX_UNITS_PER_HOUSE} units/house; PRO = unlimited).`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });