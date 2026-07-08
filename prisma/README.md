## Local database

Start PostgreSQL locally:

```bash
docker compose up -d
```

The local database is created as:

- Database: `tenant_management`
- User: `postgres`
- Password: `postgres`

Prisma environment variables live in `.env`.

When you add the full schema later, typical Prisma commands will be:

```bash
npx prisma generate
npx prisma migrate dev --name init
```
