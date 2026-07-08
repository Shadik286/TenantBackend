const checks = [
  "Prisma schema defines owners, houses, units, tenants, leases, rent, payments, expenses, attachments, and audit logs",
  "Next.js API routes now expose backend endpoints for health checks, houses, tenants, and leases",
  "The app is ready for database-backed CRUD flows aligned with the architecture",
];

const endpoints = [
  "/api/health",
  "/api/houses",
  "/api/tenants",
  "/api/leases",
];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">Tenant Management SaaS</p>
        <h1>Architecture-aligned backend foundation is now in place.</h1>
        <p className="lede">
          The project now includes a Prisma-backed domain model and server routes for
          the core rental-management workflow.
        </p>
      </section>

      <section className="status-card">
        <h2>Current status</h2>
        <ul>
          {checks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="status-card">
        <h2>Available API routes</h2>
        <ul>
          {endpoints.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <code>npm run dev</code>
      </section>
    </main>
  );
}
