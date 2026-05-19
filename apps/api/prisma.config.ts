import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7 moved connection config out of schema.prisma. The CLI (migrate /
// generate) reads the connection from this file via an adapter; the runtime
// PrismaClient is given the same adapter directly in prisma.service.ts.
export default defineConfig({
  schema: './prisma/schema.prisma',
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
