import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import api from "./app.ts";
import { passwordMiddleware } from "./auth.ts";
import { closeBrowser } from "./network.ts";

const port = Number(process.env.PORT ?? 3000);

const app = new Hono()
  // Covers both the API and the static frontend.
  .use("*", passwordMiddleware(process.env.APP_PASSWORD))
  .route("/", api)
  .use("/*", serveStatic({ root: "./dist" }))
  .get("*", serveStatic({ path: "./dist/index.html" }));

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`scrape-zone listening on http://localhost:${info.port}`);
});

// `docker stop` sends SIGTERM: stop accepting requests and close Chromium before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void closeBrowser().finally(() => process.exit(0));
  });
}
