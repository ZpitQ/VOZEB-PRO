import { initializePostgresSchema } from "../src/lib/server/database/postgres";

if (process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres") throw new Error("PostgreSQL integration setup requires the postgres provider");

await initializePostgresSchema();
