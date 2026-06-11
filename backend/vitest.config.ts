import { defineConfig } from "vitest/config";

// Backend unit tests run in a plain Node environment. The `.js`-extension
// imports used throughout src/ resolve to their .ts sources via Vite's resolver
// (same as tsx/tsc Bundler resolution), so no alias/deps config is needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
