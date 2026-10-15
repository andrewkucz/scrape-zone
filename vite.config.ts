import { defineConfig } from "vite-plus";

// Workspace-wide format, lint and staged-check settings. App/library build
// config lives in each package's own vite.config.ts.
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // Fixtures are captured server responses and must stay byte-for-byte.
    ignorePatterns: ["**/tests/fixtures/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
