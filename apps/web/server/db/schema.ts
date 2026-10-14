import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema.ts";

export * from "./auth-schema.ts";

/**
 * URLs each user has scraped: one row per URL, bumped to the top on every rescrape
 * and keeping the request options of the latest one.
 */
export const scrapeHistory = sqliteTable(
  "scrape_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    method: text("method").default("GET").notNull(),
    headers: text("headers", { mode: "json" })
      .$type<Record<string, string>>()
      .default(sql`'{}'`)
      .notNull(),
    body: text("body"),
    proxy: integer("proxy", { mode: "boolean" }).default(false).notNull(),
    scrapedAt: integer("scraped_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("scrape_history_user_url_idx").on(table.userId, table.url),
    index("scrape_history_user_scraped_at_idx").on(table.userId, table.scrapedAt),
  ],
);
