const { PrismaClient } = require('@prisma/client');
(async () => {
  const p = new PrismaClient();
  const cols = await p.$queryRawUnsafe(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'Tenant' AND table_schema = 'public' ORDER BY ordinal_position"
  );
  console.log(JSON.stringify(cols, null, 2));
  await p.$disconnect();
})();
