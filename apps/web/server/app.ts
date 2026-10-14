import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { isScrapeError, type ScrapeErrorCode } from "scrape-ts";
import { z } from "zod";
import { auth, requireSession, type AuthEnv } from "./auth.ts";
import { deleteHistoryEntry, listHistory, recordScrape } from "./history.ts";
import { captureNetwork, NetworkCaptureError } from "./network.ts";
import { normalizeUrl, scrape } from "./scrape.ts";

const CLIENT_ERRORS = new Set<ScrapeErrorCode>(["INVALID_URL", "UNSUPPORTED_PROTOCOL", "NOT_HTML"]);

const urlQuery = zValidator("query", z.object({ url: z.string().min(1) }));

function unknownError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { error: { code: "UNKNOWN", message } };
}

const api = new Hono<AuthEnv>()
  .use(compress())
  // better-auth's own endpoints (sign in/out, session); everything after requires a session.
  .on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw))
  .use(requireSession)
  .get("/scrape", urlQuery, async (c) => {
    const url = normalizeUrl(c.req.valid("query").url);
    try {
      const result = await scrape(url);
      await recordScrape(c.get("session").user.id, url);
      return c.json(result, 200);
    } catch (error) {
      if (isScrapeError(error)) {
        const status = CLIENT_ERRORS.has(error.code) ? 400 : 502;
        return c.json({ error: { code: error.code, message: error.message } }, status);
      }
      return c.json(unknownError(error), 500);
    }
  })
  // Expensive (launches a browser page), so the client only calls it on demand.
  .get("/network", urlQuery, async (c) => {
    const url = normalizeUrl(c.req.valid("query").url);
    try {
      return c.json(await captureNetwork(url), 200);
    } catch (error) {
      if (error instanceof NetworkCaptureError) {
        const status =
          error.code === "INVALID_URL" ? 400 : error.code === "NAVIGATION_FAILED" ? 502 : 500;
        return c.json({ error: { code: error.code, message: error.message } }, status);
      }
      return c.json(unknownError(error), 500);
    }
  })
  .get("/history", async (c) => c.json({ entries: await listHistory(c.get("session").user.id) }))
  .delete(
    "/history/:id",
    zValidator("param", z.object({ id: z.coerce.number().int() })),
    async (c) => {
      await deleteHistoryEntry(c.get("session").user.id, c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

const app = new Hono().route("/api", api);

export type AppType = typeof app;
export default app;
