// dotenv is a transitive dep (@nestjs/config) — not directly resolvable in
// pnpm strict mode at runtime. Guard the import so the config still evaluates
// when dotenv isn't reachable (Railway injects env vars into the container).
try { require('dotenv/config'); } catch {}
import { defineConfig } from 'prisma/config';

// Prisma 7 moved connection config out of schema.prisma. Two surfaces need
// it now:
//   - `datasource.url`  → consumed by the CLI (migrate deploy / migrate
//                          dev / db push). The migration engine uses a
//                          direct Postgres connection, not a driver
//                          adapter. Without it `prisma migrate deploy`
//                          errors out with:
//                            "The datasource.url property is required in
//                             your Prisma config file when using prisma
//                             migrate deploy."
//   - `adapter()`       → consumed by the runtime PrismaClient (via the
//                          PrismaPg driver). Same connection string,
//                          different code path.
export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
  migrations: {
    path: './prisma/migrations',
  },
  async adapter() {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    return new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
  },
});
