#!/usr/bin/env node
/**
 * Package the extension for the Chrome Web Store.
 *
 *   npm run package:extension
 *
 * Builds a fresh production bundle and zips the CONTENTS of extension/dist
 * (manifest.json at the zip root, as the store requires) into
 * release/comms-assistant-v<version>.zip.
 *
 * This produces the upload artifact. Submitting it to the store is a manual
 * step in the Chrome Web Store developer dashboard — see docs/PUBLISHING.md.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extension = join(root, "extension");
const dist = join(extension, "dist");
const releaseDir = join(root, "release");

const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf-8"));
const version = manifest.version || "0.0.0";
const zipName = `comms-assistant-v${version}.zip`;
const zipPath = join(releaseDir, zipName);

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// 1. Fresh build
run("npm run build", extension);
if (!existsSync(join(dist, "manifest.json"))) {
  console.error("Build did not produce dist/manifest.json — aborting.");
  process.exit(1);
}

// 2. Clean output
if (!existsSync(releaseDir)) mkdirSync(releaseDir, { recursive: true });
if (existsSync(zipPath)) rmSync(zipPath);

// 3. Zip the contents of dist (cross-platform)
const fwd = (p) => p.replace(/\\/g, "/");
if (process.platform === "win32") {
  const ps = `Compress-Archive -Path '${fwd(dist)}/*' -DestinationPath '${fwd(zipPath)}' -Force`;
  run(`powershell -NoProfile -Command "${ps}"`, root);
} else {
  run(`cd "${dist}" && zip -r -q "${zipPath}" .`, root);
}

if (!existsSync(zipPath)) {
  console.error("Zip was not created — check the zip tool for your platform.");
  process.exit(1);
}

const kb = (statSync(zipPath).size / 1024).toFixed(0);
console.log(`\n✓ Packaged ${zipName} (${kb} KB)  →  release/${zipName}`);
console.log("Upload it at the Chrome Web Store developer dashboard — see docs/PUBLISHING.md.");
