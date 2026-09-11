import { PrismaClient } from "@prisma/client";

/**
 * One-off backfill: every Unit should have at least one OPEN RentRate row
 * (`effective_to IS NULL`). Older units that were created before the
 * RentRate feature was wired up have no rate row, which made the Flutter
 * app render "৳0.00" for the rent in the unit-details modal.
 *
 * For every unit without an open rate we insert a placeholder row with
 * amount = 0 and effective_from = created_at (or now() if missing). The
 * owner can then edit the unit to set the real rent, which closes the
 * placeholder row and opens a new one with the correct amount.
 *
 * Safe to run repeatedly: only inserts when no open row exists.
 */
const prisma = new PrismaClient();

async function main() {
  const units = await prisma.unit.findMany({
    where: { deleted_at: null },
    select: {
      id: true,
      name: true,
      house_id: true,
      created_at: true,
      rent_rates: {
        where: { effective_to: null },
        select: { id: true },
        take: 1,
      },
    },
  });

  const missing = units.filter((u) => u.rent_rates.length === 0);
  console.log(
    `Scanned ${units.length} active units; ${missing.length} missing an open RentRate row.`,
  );

  if (missing.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // We need a valid `set_by` user (the unit owner). Pull from the house.
  const houseIds = Array.from(new Set(missing.map((u) => u.house_id)));
  const houses = await prisma.house.findMany({
    where: { id: { in: houseIds } },
    select: { id: true, owner_id: true },
  });
  const ownerByHouse = new Map(houses.map((h) => [h.id, h.owner_id]));

  let inserted = 0;
  for (const u of missing) {
    const setBy = ownerByHouse.get(u.house_id);
    if (!setBy) {
      console.warn(`  skip ${u.id} (${u.name}): no house owner`);
      continue;
    }
    await prisma.rentRate.create({
      data: {
        unit_id: u.id,
        amount: 0,
        effective_from: u.created_at ?? new Date(),
        effective_to: null,
        set_by: setBy,
        notes: "Backfilled placeholder — please edit the unit to set the real rent.",
      },
    });
    inserted++;
    console.log(`  backfilled ${u.id} (${u.name})`);
  }
  console.log(`Done. Inserted ${inserted} placeholder RentRate row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
