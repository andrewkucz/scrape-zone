import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import api from "./app.ts";
import { passwordMiddleware } from "./auth.ts";

const port = Number(process.env.PORT ?? 3000);

const app = new Hono()
  // Covers both the API and the static frontend.
  .use("*", passwordMiddleware(process.env.APP_PASSWORD))
  .route("/", api)
  .use("/*", serveStatic({ root: "./dist" }))
  .get("*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`scrape-zone listening on http://localhost:${info.port}`);
});
