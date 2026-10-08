import devServer from "@hono/vite-dev-server";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite-plus";
import { createPasswordCheck, isAuthorizedHeader, REALM } from "./server/auth.ts";

/** Dev-server twin of the production password middleware in server/index.ts. */
function passwordProtect(password: string | undefined): Plugin {
  return {
    name: "scrape-zone:password",
    configureServer(server) {
      const check = createPasswordCheck(password);
      if (!check) return;
      server.middlewares.use((req, res, next) => {
        if (isAuthorizedHeader(check, req.headers.authorization)) return next();
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", `Basic realm="${REALM}"`);
        res.end("Unauthorized");
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    // First, so it guards the page, assets and the /api routes alike.
    passwordProtect(loadEnv(mode, process.cwd(), "").APP_PASSWORD),
    react(),
    // Serves the Hono API from the Vite dev server; everything outside /api goes to Vite.
    devServer({ entry: "server/app.ts", exclude: [/^(?!\/api(\/|$)).*/] }),
  ],
  // Module workers, so the lazily loaded quicktype worker can code-split.
  worker: { format: "es" },
  // Only imported from a lazily created worker, so pre-bundle it up front instead of
  // letting the dev server discover it on first use and force a page reload.
  optimizeDeps: { include: ["quicktype-core"] },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
}));
