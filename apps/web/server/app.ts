import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { BotProtectionError, isScrapeError, type ScrapeErrorCode } from "scrape-ts";
import { z } from "zod";
import { auth, requireSession, type AuthEnv } from "./auth.ts";
import { deleteHistoryEntry, listHistory, recordScrape } from "./history.ts";
import { captureNetwork, NetworkCaptureError } from "./network.ts";
import { ProxyNotConfiguredError } from "./proxy.ts";
import { REQUEST_METHODS } from "./request.ts";
import { normalizeUrl, scrape } from "./scrape.ts";

const CLIENT_ERRORS = new Set<ScrapeErrorCode>(["INVALID_URL", "UNSUPPORTED_PROTOCOL", "NOT_HTML"]);

const scrapeRequest = zValidator(
  "json",
  z.object({
    url: z.string().min(1),
    method: z.enum(REQUEST_METHODS).default("GET"),
    headers: z.record(z.string().min(1), z.string()).default({}),
    body: z.string().optional(),
    proxy: z.boolean().default(false),
  }),
);

function proxyError(error: ProxyNotConfiguredError) {
  return { error: { code: error.code, message: error.message } };
}

const PROVIDER_NAMES: Record<BotProtectionError["provider"], string> = {
  cloudflare: "Cloudflare",
  akamai: "Akamai",
  datadome: "DataDome",
  perimeterx: "HUMAN (PerimeterX)",
  imperva: "Imperva",
  "aws-waf": "AWS WAF",
  kasada: "Kasada",
  sucuri: "Sucuri",
  f5: "F5",
  vercel: "Vercel",
  anubis: "Anubis",
  wordfence: "Wordfence",
  unknown: "a captcha",
};

function botProtectionError(error: BotProtectionError, proxy: boolean) {
  const statusText = error.status ? ` (HTTP ${error.status})` : "";
  const hint = proxy ? "" : " Enabling the proxy may help.";
  return {
    error: {
      code: error.code,
      message: `Request was blocked by ${PROVIDER_NAMES[error.provider]} bot protection${statusText}: ${error.reason}.${hint}`,
      provider: error.provider,
    },
  };
}

function unknownError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { error: { code: "UNKNOWN", message } };
}

const api = new Hono<AuthEnv>()
  .use(compress())
  // better-auth's own endpoints (sign in/out, session); everything after requires a session.
  .on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw))
  .use(requireSession)
  .post("/scrape", scrapeRequest, async (c) => {
    const { url: rawUrl, ...request } = c.req.valid("json");
    const url = normalizeUrl(rawUrl);
    try {
      const result = await scrape(url, request);
      await recordScrape(c.get("session").user.id, url, request);
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof BotProtectionError) {
        return c.json(botProtectionError(error, request.proxy), 502);
      }
      if (isScrapeError(error)) {
        const status = CLIENT_ERRORS.has(error.code) ? 400 : 502;
        return c.json({ error: { code: error.code, message: error.message } }, status);
      }
      if (error instanceof ProxyNotConfiguredError) return c.json(proxyError(error), 503);
      return c.json(unknownError(error), 500);
    }
  })
  // Expensive (launches a browser page), so the client only calls it on demand.
  .post("/network", scrapeRequest, async (c) => {
    const { url: rawUrl, ...request } = c.req.valid("json");
    const url = normalizeUrl(rawUrl);
    try {
      return c.json(await captureNetwork(url, request), 200);
    } catch (error) {
      if (error instanceof NetworkCaptureError) {
        const status =
          error.code === "INVALID_URL" || error.code === "UNSUPPORTED_METHOD"
            ? 400
            : error.code === "NAVIGATION_FAILED"
              ? 502
              : 500;
        return c.json({ error: { code: error.code, message: error.message } }, status);
      }
      if (error instanceof ProxyNotConfiguredError) return c.json(proxyError(error), 503);
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
