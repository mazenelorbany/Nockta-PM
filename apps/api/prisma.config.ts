import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 moved connection config out of schema.prisma. The CLI (migrate /
// generate / studio) needs `url` for the migration engine (which uses a direct
// Postgres connection, not a driver adapter). The `adapter` is used by the
// runtime PrismaClient given the same adapter directly in prisma.service.ts.
export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  // Required by `prisma migrate deploy` — the migration engine uses a direct
  // connection, not the driver adapter.
  url: process.env.DATABASE_URL,
  async adapter() {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    return new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
  },
});
