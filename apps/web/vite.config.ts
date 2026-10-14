import devServer from "@hono/vite-dev-server";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

// The dev API runs inside this process, so expose .env (BETTER_AUTH_SECRET etc.)
// to it the way `node --env-file` does in production.
function loadServerEnv(mode: string) {
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
    process.env[key] ??= value;
  }
}

export default defineConfig(({ mode }) => {
  loadServerEnv(mode);
  return {
    plugins: [
      react(),
      // Serves the Hono API from the Vite dev server; everything outside /api goes to Vite.
      devServer({ entry: "server/app.ts", exclude: [/^(?!\/api(\/|$)).*/] }),
    ],
    // Module workers, so the lazily loaded quicktype worker can code-split.
    worker: { format: "es" },
    // Only imported from a lazily created worker, so pre-bundle it up front instead of
    // letting the dev server discover it on first use and force a page reload.
    optimizeDeps: { include: ["quicktype-core"] },
    run: {
      tasks: {
        // Both consume scrape-ts from its built dist/, so build it (and any other
        // workspace dependency) first.
        dev: {
          command: "vp dev",
          dependsOn: [{ task: "build", from: "dependencies" }],
          cache: false,
        },
        build: {
          command: "tsc && vp build",
          dependsOn: [{ task: "build", from: "dependencies" }],
        },
      },
    },
  };
});
