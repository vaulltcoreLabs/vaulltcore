import { defineConfig } from "vitest/config";
import path from "path";

// The web package's per-package vitest config is only loaded when running
// inside that package. `npm test` at the monorepo root runs vitest from the
// root, so the `@` alias the web sources rely on must be declared here too.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "packages/vaulltcore-web/src"),
    },
  },
});