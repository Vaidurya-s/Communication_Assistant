import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// A SEPARATE config from vite.config.ts on purpose: Vitest prefers this file
// and does not merge vite.config.ts, so the build-only `crx({manifest})` plugin
// (which would break under test) is bypassed entirely. Only react() is loaded.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
