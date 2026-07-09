// One-shot probe to confirm the User table exists on the live Supabase pooler
// and print its columns + row count.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  try {
    const cols = await p.$queryRawUnsafe(
      "SELECT column_name, data_type FROM information_schema.columns " +
      "WHERE table_schema = 'public' AND table_name = 'User' " +
      "ORDER BY ordinal_position"
    );
    if (cols.length === 0) {
      console.log("User table is MISSING from the public schema.");
    } else {
      console.log("User columns (" + cols.length + "):");
      for (const c of cols) console.log("  - " + c.column_name + " : " + c.data_type);
    }

    const tables = await p.$queryRawUnsafe(
      "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'public' ORDER BY table_name"
    );
    console.log("\nAll public tables (" + tables.length + "):");
    for (const t of tables) console.log("  - " + t.table_name);

    const c = await p.$queryRawUnsafe('SELECT count(*)::int AS n FROM "User"');
    console.log("\nUser row count: " + c[0].n);
  } catch (e) {
    console.error("ERR", e.message);
  } finally {
    await p.$disconnect();
  }
})();