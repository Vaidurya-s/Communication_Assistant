#!/usr/bin/env node
/**
 * One-command setup for Comms Assistant.
 *
 *   npm run setup
 *
 * Installs backend + extension dependencies, builds the extension, and
 * scaffolds the local config you need to fill in (voice profile, .env).
 * Safe to run repeatedly — it never overwrites files you've already edited.
 */
import { execSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const backend = join(root, "backend");
const extension = join(root, "extension");
const voiceDir = join(root, "voice_profile");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};
const log = (m = "") => console.log(m);
const head = (m) => log(`\n${C.bold}${C.cyan}${m}${C.reset}`);
const ok = (m) => log(`${C.green}✓${C.reset} ${m}`);
const warn = (m) => log(`${C.yellow}!${C.reset} ${m}`);

function run(cmd, cwd) {
  log(`${C.dim}$ ${cmd}  (in ${cwd.replace(root, ".")})${C.reset}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    warn(`Node ${process.versions.node} detected — this project needs Node 18+. Please upgrade and re-run.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);
}

function copyIfMissing(from, to, label) {
  if (existsSync(to)) {
    ok(`${label} already exists — left untouched`);
    return false;
  }
  if (!existsSync(from)) {
    warn(`${label}: template not found at ${from} — skipped`);
    return false;
  }
  copyFileSync(from, to);
  ok(`${label} created`);
  return true;
}

function ensureRawCorpus() {
  const dir = join(voiceDir, "raw_corpus");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# raw_corpus — your real messages (private, gitignored)",
        "",
        "Drop plain-text or Markdown files of messages **you have written** in here:",
        "exported LinkedIn DMs, sent emails, Slack messages — anything that sounds like you.",
        "",
        "Then run, from the project root:",
        "",
        "    npm run init-voice",
        "",
        "That reads these files and uses your configured AI to draft",
        "`voice_profile/strategy_analysis.md` — the file the assistant uses to match",
        "your writing style. Review and tweak the draft afterwards.",
        "",
        "Nothing in this folder is committed to git.",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
  ok("voice_profile/raw_corpus/ ready (drop your past messages here)");
}

async function main() {
  log(`${C.bold}Comms Assistant — setup${C.reset}`);

  head("1. Checking prerequisites");
  checkNode();

  head("2. Installing backend dependencies");
  run("npm install", backend);

  head("3. Installing extension dependencies");
  run("npm install", extension);

  head("4. Building the extension");
  run("npm run build", extension);
  ok("Extension built → extension/dist");

  head("5. Scaffolding your local config");
  copyIfMissing(
    join(voiceDir, "templates", "strategy_analysis.md.template"),
    join(voiceDir, "strategy_analysis.md"),
    "voice_profile/strategy_analysis.md",
  );
  copyIfMissing(
    join(backend, ".env.example"),
    join(backend, ".env"),
    "backend/.env",
  );
  ensureRawCorpus();

  head("Setup complete ✅  —  next steps");
  log(`
  ${C.bold}a) Pick your AI${C.reset}  (edit ${C.cyan}backend/.env${C.reset})
     • Default is the local ${C.cyan}gemini${C.reset} CLI — no key needed if it's installed & signed in.
     • Or set ${C.cyan}LLM_PROVIDER=openai-compat${C.reset} and add your ${C.cyan}OPENAI_API_KEY${C.reset}
       (works with OpenAI, OpenRouter, Ollama, LM Studio, …).

  ${C.bold}b) Teach it your voice${C.reset}
     • Easiest: drop a few of your real sent messages into
       ${C.cyan}voice_profile/raw_corpus/${C.reset} and run  ${C.cyan}npm run init-voice${C.reset}
     • Or hand-write ${C.cyan}voice_profile/strategy_analysis.md${C.reset} (it's pre-filled from a template).

  ${C.bold}c) Start the backend${C.reset}
     ${C.cyan}npm start${C.reset}      ${C.dim}# http://localhost:8000${C.reset}

  ${C.bold}d) Load the extension${C.reset}
     chrome://extensions → Developer mode → Load unpacked → ${C.cyan}extension/dist${C.reset}

  Full walkthrough: ${C.cyan}SETUP.md${C.reset}
`);
}

main().catch((err) => {
  console.error(`\n${C.yellow}Setup failed:${C.reset} ${err.message}`);
  console.error("Fix the issue above and re-run `npm run setup`.");
  process.exit(1);
});
