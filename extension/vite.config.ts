import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { crx, type ManifestV3Export } from "@crxjs/vite-plugin";
import type { PreRenderedChunk } from "rollup";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf-8"),
) as ManifestV3Export;

/**
 * Stable, content-independent output filenames.
 *
 * Vite's default `[name]-[hash].js` renames every chunk whose content changes,
 * and `dist/manifest.json` is regenerated to point at the new names. That is
 * correct for a web app served over HTTP — and actively hostile for an unpacked
 * extension, because Chrome keeps serving the manifest it loaded. Any rebuild
 * after a "Load unpacked" leaves Chrome asking for a filename that no longer
 * exists, which surfaces to the user as:
 *
 *     content script not loaded and auto-inject failed:
 *     Could not load file: 'assets/index.ts-loader-<old hash>.js'
 *
 * With stable names a stale manifest still resolves, so a plain tab reload picks
 * up new content-script code and only genuine manifest changes (a new
 * permission, a new match pattern) need the extension reloaded.
 *
 * Cache-busting is what the hash buys, and it is worth nothing here: the files
 * are read from disk, not fetched over a network.
 *
 * Names must stay unique. Several entries share the basename `index.ts`
 * (`content/index.ts`, `background/index.ts`, `popup/index.html`), so the name
 * is derived from the module's directory as well — `content-index`,
 * `background-index` — rather than from `[name]` alone, which would collide and
 * have one chunk silently overwrite another.
 */
function stableName(chunk: PreRenderedChunk): string {
  const id = chunk.facadeModuleId;
  if (id) {
    const norm = id.replace(/\\/g, "/");
    const m = /\/src\/(.+)$/.exec(norm);
    if (m) {
      // "content/index.ts" -> "content-index"; drop the extension(s).
      const slug = m[1]
        .replace(/\.[^./]+$/, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (slug) return slug;
    }
  }
  // Vendor chunks and anything without a facade module keep their rollup name.
  return chunk.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: (chunk) => `assets/${stableName(chunk)}.js`,
        chunkFileNames: (chunk) => `assets/${stableName(chunk)}.js`,
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
