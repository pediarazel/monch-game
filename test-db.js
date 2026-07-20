const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
require("dotenv").config({ quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL در فایل .env تعریف نشده است");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
  log: ["error", "warn"],
});

async function main() {
  const result = await prisma.$queryRaw`SELECT 1 AS ok`;
  console.log("✅ اتصال SSL به دیتابیس Render برقرار شد");
  console.log("📌 نتیجه آزمایش:", result);
}

main()
  .catch((error) => {
    console.error("❌ خطا در اتصال:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
