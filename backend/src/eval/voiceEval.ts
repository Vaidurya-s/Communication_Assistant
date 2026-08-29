/**
 * Voice-quality eval harness.
 *
 *   npm run voice:eval            (from backend/)   — or from root
 *
 * Generates replies for a fixed set of fictional scenarios THROUGH THE REAL
 * pipeline (buildPrompt → runLLM, the same inputs as /analyze), then scores how
 * well they match your voice: deterministic heuristics (length fit vs your real
 * corpus, no-cliché) + an LLM judge. Prints a 0–100 voice score and writes a
 * JSON report so you can compare before/after a prompt or profile change.
 *
 * Privacy: scenarios are fictional; the corpus is read as word-count statistics
 * for length calibration and as few-shot examples for the draft, but is never
 * sent to the JUDGE and never committed; the report lands in the gitignored
 * backend/data/.
 *
 * KEEPING THIS HONEST: the harness only measures what it actually feeds the
 * model. It used to pass just {ctx, voiceProfile, mode, steer} while /analyze
 * had grown to inject ABOUT ME items and ranked few-shot examples too — so it
 * was silently scoring a pipeline that no longer existed, and no amount of
 * retrieval work could ever move the number. It now builds the same inputs
 * /analyze does. If you add another input there, add it here or this stops
 * measuring the product.
 *
 * Flags (for before/after comparison):
 *   --no-examples   omit the few-shot corpus examples
 *   --no-aboutme    omit the ABOUT ME context items
 * Both are recorded in the report so two runs can be compared meaningfully.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runLLM } from "../llm/index.js";
import { buildPrompt } from "../prompt.js";
import { loadVoiceProfile } from "../voiceProfile.js";
import { ensureWorkspace } from "../workspace.js";
import { SCENARIOS } from "./scenarios.js";
import { loadCorpusExchanges } from "../corpus.js";
import { selectAboutMeContext, selectRelevantContext } from "../contextRetrieval.js";
import { getConfirmedContext } from "../context.js";
import {
  composite,
  corpusLengthBand,
  lengthFitScore,
  noClicheScore,
  parseJudgeScores,
  splitCorpus,
  type LengthBand,
} from "./metrics.js";

const VOICE_DIR = resolve(process.cwd(), "..", "voice_profile");
const RAW_DIR = join(VOICE_DIR, "raw_corpus");
const CORPUS_FILE = join(VOICE_DIR, "linkedin_successful_messages.md");
const REPORT_DIR = resolve(process.cwd(), "data", "voice-eval");

function wc(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Read the corpus for length calibration. Mirrors initVoice's collectRaw, but
 * we only ever derive statistics from it — never echo or store the content. */
function readCorpus(): string {
  const parts: string[] = [];
  if (existsSync(RAW_DIR)) {
    for (const name of readdirSync(RAW_DIR)) {
      if (name.startsWith(".") || name.toLowerCase() === "readme.md") continue;
      try {
        const b = readFileSync(join(RAW_DIR, name), "utf-8");
        if (b.trim()) parts.push(b);
      } catch {
        /* skip unreadable */
      }
    }
  }
  if (existsSync(CORPUS_FILE)) {
    try {
      const b = readFileSync(CORPUS_FILE, "utf-8");
      if (b.trim()) parts.push(b);
    } catch {
      /* skip */
    }
  }
  return parts.join("\n\n");
}

/**
 * The ranking signal for a scenario, mirroring the `aboutSignal` /analyze builds
 * from the contact profile plus recent messages. Scenarios carry no profile, so
 * it's the title and the conversation.
 */
function signalFor(sc: (typeof SCENARIOS)[number]): string {
  return [sc.ctx.conversation_title, ...sc.ctx.messages.map((m) => m.text), sc.ctx.current_draft]
    .filter(Boolean)
    .join(" ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const useExamples = !argv.includes("--no-examples");
  const useAboutMe = !argv.includes("--no-aboutme");

  const voice = loadVoiceProfile();
  if (voice.length < 40) {
    console.error("Voice profile missing or empty — run `npm run init-voice` first.");
    process.exit(1);
  }

  const band: LengthBand = corpusLengthBand(splitCorpus(readCorpus()));
  console.log(`Voice profile: ${voice.length} chars.`);

  // Same inputs /analyze assembles, so the score reflects the real product.
  const corpus = useExamples ? loadCorpusExchanges() : [];
  const contextItems = useAboutMe ? getConfirmedContext("local") : [];
  console.log(
    `Inputs: few-shot ${useExamples ? `ON (${corpus.length} exchanges available)` : "OFF"} · ` +
      `ABOUT ME ${useAboutMe ? `ON (${contextItems.length} confirmed items)` : "OFF"}`,
  );
  console.log(`Your corpus length band (words): p10=${band.p10} · median=${band.median} · p90=${band.p90}`);
  console.log(
    `\nGenerating ${SCENARIOS.length} replies via the configured LLM ` +
      "(this can take a few minutes on gemini-cli)…",
  );

  ensureWorkspace(); // gemini-cli sandbox cwd

  const rows: Array<{ name: string; reply: string; words: number; cliche: ReturnType<typeof noClicheScore> }> = [];
  for (const sc of SCENARIOS) {
    const signal = signalFor(sc);
    const { instruction, context } = buildPrompt({
      ctx: sc.ctx,
      voiceProfile: voice,
      mode: sc.mode,
      steer: sc.steer,
      aboutMe: selectAboutMeContext(contextItems, signal).map((c) => ({
        type: c.type,
        title: c.title,
        body: c.body,
      })),
      examples: selectRelevantContext(corpus, signal, { max: 2 }).map((e) => ({
        title: e.title,
        body: e.body,
      })),
    });
    // Retry once on an empty reply — gemini-cli occasionally returns nothing on
    // its cold first call, which would otherwise tank an otherwise-fine score.
    let reply = "";
    for (let attempt = 0; attempt < 2 && !reply; attempt++) {
      try {
        reply = (await runLLM(instruction, context)).text.trim();
      } catch (err) {
        console.warn(`  ! ${sc.name}: generation failed — ${(err as Error).message}`);
        break;
      }
    }
    rows.push({ name: sc.name, reply, words: wc(reply), cliche: noClicheScore(reply) });
    process.stdout.write(reply ? "." : "x");
  }
  process.stdout.write("\n");

  // One batched judge call over all replies.
  const judgeInstruction = [
    "You are grading how well each REPLY matches the VOICE PROFILE of one specific person.",
    "Score each reply 1–5 (5 = indistinguishable from the person; 1 = generic / off-voice).",
    "Do NOT use any tools. Output EXACTLY one line per reply, in order, formatted:",
    "REPLY <n>: <score>",
    "Output nothing else.",
  ].join("\n");
  const judgeContext = [
    "=== VOICE PROFILE ===",
    voice,
    "",
    "=== REPLIES TO GRADE ===",
    ...rows.map((r, i) => `REPLY ${i + 1}:\n${r.reply || "(empty)"}\n`),
  ].join("\n");

  let judge: number[] = [];
  try {
    judge = parseJudgeScores((await runLLM(judgeInstruction, judgeContext)).text);
  } catch (err) {
    console.warn(`  ! judge failed — ${(err as Error).message}`);
  }

  const report = rows.map((r, i) => {
    const lengthFit = lengthFitScore(r.words, band);
    const j = judge[i] ?? null;
    return {
      name: r.name,
      words: r.words,
      lengthFit: Number(lengthFit.toFixed(2)),
      cliche: Number(r.cliche.score.toFixed(2)),
      clicheHits: r.cliche.hits,
      judge: j,
      score: composite({ judge1to5: j, lengthFit, cliche: r.cliche.score }),
      reply: r.reply,
    };
  });
  const overall = report.length ? Math.round(report.reduce((s, r) => s + r.score, 0) / report.length) : 0;

  console.log("\nScenario                          words  len   clich  judge  score");
  console.log("-".repeat(68));
  for (const r of report) {
    console.log(
      r.name.padEnd(32).slice(0, 32) +
        "  " +
        String(r.words).padStart(4) +
        "  " +
        r.lengthFit.toFixed(2) +
        "  " +
        r.cliche.toFixed(2) +
        "   " +
        String(r.judge ?? "–").padStart(3) +
        "    " +
        String(r.score).padStart(3),
    );
  }
  console.log("-".repeat(68));
  console.log(`OVERALL VOICE SCORE: ${overall}/100\n`);
  console.log("Scores are approximate and stochastic (often the same model generates AND judges).");
  console.log("Use them for RELATIVE before/after comparison when tuning the prompt or profile.");

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(REPORT_DIR, `eval-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        overall,
        // Recorded so two reports are actually comparable — an overall score
        // means nothing without knowing which inputs produced it.
        inputs: { examples: useExamples, aboutMe: useAboutMe, corpusExchanges: corpus.length },
        band,
        voiceChars: voice.length,
        report,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\nReport: ${file}`);
}

main().catch((err) => {
  console.error("\nvoice:eval failed:", (err as Error).message);
  console.error("Check that your LLM is configured in backend/.env (provider + key if needed).");
  process.exit(1);
});
