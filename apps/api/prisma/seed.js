"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
// Local dev seed. Creates an Admin user and a Backend team so the rest of the
// app has something to render. Idempotent — safe to run repeatedly.
const prisma = new client_1.PrismaClient();
async function main() {
    const admin = await prisma.user.upsert({
        where: { email: 'admin@nockta.com' },
        update: {},
        create: {
            email: 'admin@nockta.com',
            kind: 'internal',
            companyRole: 'Admin',
            name: 'Nockta Admin',
        },
    });
    await prisma.team.upsert({
        where: { slug: 'backend' },
        update: {},
        create: {
            slug: 'backend',
            name: 'Backend Team',
            description: 'Backend engineering team.',
            createdById: admin.id,
            members: { create: { userId: admin.id } },
        },
    });
    // eslint-disable-next-line no-console
    console.log('Seed complete: admin user + Backend team upserted.');
}
main()
    .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
})
    .finally(() => void prisma.$disconnect());
//# sourceMappingURL=seed.js.map