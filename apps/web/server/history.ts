import { and, desc, eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { scrapeHistory } from "./db/schema.ts";

const HISTORY_LIMIT = 50;

/** Records a scrape, moving an already-scraped URL back to the top. */
export async function recordScrape(userId: string, url: string) {
  await db
    .insert(scrapeHistory)
    .values({ userId, url, scrapedAt: new Date() })
    .onConflictDoUpdate({
      target: [scrapeHistory.userId, scrapeHistory.url],
      set: { scrapedAt: new Date() },
    });
}

export function listHistory(userId: string) {
  return db
    .select({ id: scrapeHistory.id, url: scrapeHistory.url, scrapedAt: scrapeHistory.scrapedAt })
    .from(scrapeHistory)
    .where(eq(scrapeHistory.userId, userId))
    .orderBy(desc(scrapeHistory.scrapedAt))
    .limit(HISTORY_LIMIT);
}

export async function deleteHistoryEntry(userId: string, id: number) {
  await db
    .delete(scrapeHistory)
    .where(and(eq(scrapeHistory.id, id), eq(scrapeHistory.userId, userId)));
}
