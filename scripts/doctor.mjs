#!/usr/bin/env node
/**
 * Diagnostics for Comms Assistant.
 *
 *   npm run doctor
 *
 * Checks the things that commonly trip up a fresh setup and tells you exactly
 * what to fix. Exits non-zero if anything critical is wrong (so CI/scripts can
 * gate on it).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const backend = join(root, "backend");
const voiceDir = join(root, "voice_profile");

const C = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", dim: "\x1b[2m" };
let fails = 0;
let warns = 0;
const pass = (m, d) => console.log(`  ${C.green}✓${C.reset} ${m}${d ? `  ${C.dim}— ${d}${C.reset}` : ""}`);
const fail = (m, fix) => { fails++; console.log(`  ${C.red}✗${C.reset} ${m}${fix ? `  ${C.yellow}→ ${fix}${C.reset}` : ""}`); };
const warn = (m, d) => { warns++; console.log(`  ${C.yellow}!${C.reset} ${m}${d ? `  ${C.dim}— ${d}${C.reset}` : ""}`); };

function parseEnv() {
  const p = join(backend, ".env");
  const env = {};
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 0) continue;
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[t.slice(0, i).trim()] = v;
    }
  }
  return env;
}

function onPath(cmd) {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function getHealth() {
  try {
    const res = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log(`${C.bold}Comms Assistant — doctor${C.reset}\n`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) pass(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}`, "upgrade to Node 18+");

  const env = parseEnv();
  if (!existsSync(join(backend, ".env"))) {
    warn("backend/.env not found", "run `npm run setup` (gemini-cli works without it)");
  }
  const provider = env.LLM_PROVIDER || "gemini-cli";
  pass(`Provider configured: ${provider}`);

  if (provider === "openai-compat") {
    if (env.OPENAI_API_KEY) pass("OPENAI_API_KEY set");
    else fail("OPENAI_API_KEY is empty", "add your key to backend/.env");
    pass(`OPENAI_BASE_URL: ${env.OPENAI_BASE_URL || "(OpenAI default)"}`);
  } else {
    if (onPath("gemini")) pass("gemini CLI found on PATH");
    else fail("gemini CLI not found", "install & sign in, or set LLM_PROVIDER=openai-compat in backend/.env");
  }

  const vp = join(voiceDir, "strategy_analysis.md");
  if (existsSync(vp)) {
    const sz = statSync(vp).size;
    if (sz > 40) pass("Voice profile present", `${sz} bytes`);
    else fail("Voice profile is effectively empty", "fill it, or run `npm run init-voice`");
  } else {
    fail("Voice profile missing (voice_profile/strategy_analysis.md)", "run `npm run setup` then `npm run init-voice`");
  }

  if (existsSync(join(root, "extension", "dist", "manifest.json"))) pass("Extension built (extension/dist)");
  else warn("Extension not built", "run `npm run build:extension`");

  const h = await getHealth();
  if (h) pass("Backend reachable on :8000", `provider=${h.provider}, voiceOk=${h.voiceProfileOk}`);
  else warn("Backend not running on :8000", "run `npm start` (only needed while using the extension)");

  console.log(
    `\n${fails ? `${C.red}${fails} problem(s)${C.reset}` : `${C.green}All good${C.reset}`}` +
      `${warns ? `, ${C.yellow}${warns} note(s)${C.reset}` : ""}.`,
  );
  process.exit(fails ? 1 : 0);
}

main();
