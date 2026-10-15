import { and, desc, eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { scrapeHistory } from "./db/schema.ts";
import type { RequestMethod, RequestOptions } from "./request.ts";

const HISTORY_LIMIT = 50;

/** Records a scrape, moving an already-scraped URL back to the top with its latest options. */
export async function recordScrape(userId: string, url: string, request: RequestOptions) {
  const options = {
    method: request.method,
    headers: request.headers,
    body: request.body ?? null,
    proxy: request.proxy,
    scrapedAt: new Date(),
  };
  await db
    .insert(scrapeHistory)
    .values({ userId, url, ...options })
    .onConflictDoUpdate({ target: [scrapeHistory.userId, scrapeHistory.url], set: options });
}

export async function listHistory(userId: string) {
  const rows = await db
    .select({
      id: scrapeHistory.id,
      url: scrapeHistory.url,
      scrapedAt: scrapeHistory.scrapedAt,
      method: scrapeHistory.method,
      headers: scrapeHistory.headers,
      body: scrapeHistory.body,
      proxy: scrapeHistory.proxy,
    })
    .from(scrapeHistory)
    .where(eq(scrapeHistory.userId, userId))
    .orderBy(desc(scrapeHistory.scrapedAt))
    .limit(HISTORY_LIMIT);
  return rows.map(({ id, url, scrapedAt, method, headers, body, proxy }) => ({
    id,
    url,
    scrapedAt,
    request: {
      method: method as RequestMethod,
      headers,
      body: body ?? undefined,
      proxy,
    } satisfies RequestOptions,
  }));
}

export async function deleteHistoryEntry(userId: string, id: number) {
  await db
    .delete(scrapeHistory)
    .where(and(eq(scrapeHistory.id, id), eq(scrapeHistory.userId, userId)));
}
