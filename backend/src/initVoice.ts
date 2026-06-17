/**
 * Voice profile distiller.
 *
 *   npm run init-voice           (from backend/)   — or:  npm run init-voice  (from root)
 *
 * Reads the real messages you've dropped into voice_profile/raw_corpus/ (plus
 * linkedin_successful_messages.md if present) and asks your configured LLM to
 * distill them into voice_profile/strategy_analysis.md — the single file the
 * assistant uses to sound like you.
 *
 * Safety: never overwrites an existing strategy_analysis.md. If one exists, the
 * draft is written to strategy_analysis.draft.md for you to review and rename.
 *
 * The corpus-collection + distillation logic now lives in voiceDistill.ts so
 * this CLI and the future HTTP endpoints share one implementation. This file
 * only adds the local-tenant CLI shell (console output, draft-vs-overwrite).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectCorpus, distill } from "./voiceDistill.js";
import { readFeedback } from "./feedback.js";

const VOICE_DIR = resolve(process.cwd(), "..", "voice_profile");
const RAW_DIR = join(VOICE_DIR, "raw_corpus");
const OUT = join(VOICE_DIR, "strategy_analysis.md");
const DRAFT = join(VOICE_DIR, "strategy_analysis.draft.md");

async function main(): Promise<void> {
  if (!existsSync(VOICE_DIR)) mkdirSync(VOICE_DIR, { recursive: true });

  const { text, fileCount } = collectCorpus();
  if (!text) {
    console.error(
      "No source messages found.\n\n" +
        `Put a few of your real sent messages (LinkedIn DMs, emails, …) into:\n` +
        `  ${RAW_DIR}\n` +
        "then run this again. (linkedin_successful_messages.md is also picked up if present.)",
    );
    process.exit(1);
  }

  const clipped = text.length > 20_000;
  console.log(
    `Found ${fileCount} source file(s)${clipped ? " (truncated to fit)" : ""}. ` +
      "Distilling your voice profile via the configured LLM — this can take up to a minute…",
  );

  // Fold in any corrections captured via 👍/👎 in the overlay.
  const feedback = readFeedback();
  const body = await distill(undefined, {
    corpusText: text,
    feedback: feedback || undefined,
  });

  const wroteDraft = existsSync(OUT);
  const target = wroteDraft ? DRAFT : OUT;
  writeFileSync(target, body, "utf-8");

  console.log(`\n✓ Wrote ${target}`);
  if (wroteDraft) {
    console.log(
      "strategy_analysis.md already existed, so I saved a draft instead.\n" +
        "Compare them and rename the draft over the original if you prefer it.",
    );
  } else {
    console.log(
      "This is now your runtime voice profile. Open it, fix anything that's off,\n" +
        "then start the backend with `npm start`.",
    );
  }
}

main().catch((err) => {
  console.error("\ninit-voice failed:", (err as Error).message);
  console.error(
    "Check that your LLM is configured in backend/.env (provider + key if needed).",
  );
  process.exit(1);
});
