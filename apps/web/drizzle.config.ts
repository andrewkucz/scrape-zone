import { defineConfig } from "drizzle-kit";

// `vp run db:generate` turns schema changes into SQL migrations, applied on server start.
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
});
