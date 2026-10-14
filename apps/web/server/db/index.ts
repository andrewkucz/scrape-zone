import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema.ts";

/** Accounts, sessions and scrape history, in one local SQLite file. */
const databasePath = process.env.DATABASE_PATH ?? "data/scrape-zone.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });

export const db = drizzle({ client: createClient({ url: `file:${databasePath}` }), schema });

// Applies any pending migrations from `vp run db:generate`; a no-op once current.
await migrate(db, { migrationsFolder: join(import.meta.dirname, "migrations") });
