import express, { type Request, type Response } from "express";
import cors from "cors";
import { runLLM, getProviderName } from "./llm/index.js";
import { loadVoiceProfile, validateVoiceProfile, VoiceProfileMissingError } from "./voiceProfile.js";
import { buildPrompt, type Mode } from "./prompt.js";
import {
  addNote,
  getContact,
  getNotesFor,
  recordStrategy,
  setFollowupAt,
  upsertContact,
  upsertProfile,
} from "./memory.js";
import type { IncomingContactProfile } from "./prompt.js";
import { generateInsight } from "./insight.js";
import { ensureWorkspace } from "./workspace.js";
import { listSnapshots, saveSnapshot } from "./snapshots.js";
import { appendFeedback } from "./feedback.js";

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "suggest",
  "continue_draft",
  "shorter",
  "longer",
  "follow_up",
]);

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

let cachedVoice: string | null = null;
function getVoice(): string {
  if (cachedVoice === null) cachedVoice = loadVoiceProfile();
  return cachedVoice;
}

app.get("/health", (_req: Request, res: Response) => {
  const voiceChars = getVoice().length;
  res.json({
    ok: true,
    voiceProfileChars: voiceChars,
    voiceProfileOk: voiceChars > 40,
    provider: getProviderName(),
  });
});

app.post("/analyze", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const ctx = body;
  const messageCount = Array.isArray(ctx?.messages) ? ctx.messages.length : 0;
  const draftLen = (ctx?.current_draft ?? "").length;

  const rawMode = typeof body.mode === "string" ? body.mode : "suggest";
  const mode: Mode = VALID_MODES.has(rawMode as Mode) ? (rawMode as Mode) : "suggest";
  const seedText: string = typeof body.seed_text === "string" ? body.seed_text : "";
  const steer: string = typeof body.steer === "string" ? body.steer : "";

  const contactName: string =
    typeof ctx?.conversation_title === "string" ? ctx.conversation_title.trim() : "";
  const threadUrl: string | null =
    typeof ctx?.page_metadata?.url === "string" ? ctx.page_metadata.url : null;

  console.log(
    `[analyze] mode=${mode} contact=${JSON.stringify(contactName)} messages=${messageCount} draft_len=${draftLen} seed_len=${seedText.length}`,
  );

  if (mode === "shorter" || mode === "longer") {
    if (!seedText.trim()) {
      res.status(400).json({ error: `mode '${mode}' requires seed_text` });
      return;
    }
  } else if (messageCount === 0 && draftLen === 0) {
    res.status(400).json({ error: "no messages and no draft — nothing to suggest from" });
    return;
  }

  // Read memory for this contact and inject into prompt.
  let existingNoteBodies: string[] = [];
  if (contactName) {
    upsertContact(contactName, threadUrl);
    existingNoteBodies = getNotesFor(contactName).map((n) => n.body);

    // Persist the contact profile (if attached). The extension caches profiles
    // client-side and re-attaches them on every /analyze; we mirror it here so
    // the data survives across browser profile resets and is queryable.
    const incomingProfile = ctx?.contact_profile as IncomingContactProfile | null | undefined;
    if (incomingProfile && typeof incomingProfile === "object") {
      try {
        upsertProfile(contactName, incomingProfile);
      } catch (err) {
        console.warn("[analyze] upsertProfile failed:", (err as Error).message);
      }
    }
  }

  const { instruction, context, resolvedMode, transcript } = buildPrompt({
    ctx,
    voiceProfile: getVoice(),
    mode,
    seedText,
    steer,
    existingNotes: existingNoteBodies,
  });

  // Fire reply + insight in parallel. Insight is run on the FULL transcript
  // regardless of mode (it always benefits from full context).
  const replyPromise = runLLM(instruction, context);

  // Only run insight when we have a real conversation to analyze. shorter/formal
  // are pure rewrites — they shouldn't trigger memory updates.
  const runInsight = contactName && (mode === "suggest" || mode === "continue_draft" || mode === "follow_up");
  const insightPromise = runInsight
    ? generateInsight({
        contactName,
        transcript,
        existingNotes: getNotesFor(contactName),
        todayIso: new Date().toISOString().slice(0, 10),
      })
    : Promise.resolve({ memory_proposal: null, strategy: null });

  // The reply is the user-facing artifact. Insight is a nice-to-have. We let
  // them race independently: if insight fails or times out, we still return
  // the reply.
  const [replyResult, insightResult] = await Promise.allSettled([replyPromise, insightPromise]);

  if (replyResult.status === "rejected") {
    console.error("[analyze] reply llm failed:", replyResult.reason);
    res.status(500).json({ error: (replyResult.reason as Error)?.message ?? "reply failed" });
    return;
  }

  const reply = replyResult.value;
  const insight =
    insightResult.status === "fulfilled"
      ? insightResult.value
      : { memory_proposal: null, strategy: null };

  if (insightResult.status === "rejected") {
    console.warn("[analyze] insight llm failed (reply still returned):", (insightResult.reason as Error)?.message);
  }

  if (insight.strategy && contactName) {
    recordStrategy(contactName, insight.strategy.text, insight.strategy.suggested_followup_at);
    if (insight.strategy.suggested_followup_at) {
      setFollowupAt(contactName, insight.strategy.suggested_followup_at);
    }
  }

  res.json({
    suggested_reply: reply.text,
    memory_proposal: insight.memory_proposal,
    strategy: insight.strategy,
    stats: {
      message_count: messageCount,
      draft_len: draftLen,
      seed_len: seedText.length,
      requested_mode: mode,
      resolved_mode: resolvedMode,
      llm_ms: reply.durationMs,
      provider: getProviderName(),
      had_existing_notes: existingNoteBodies.length,
      insight_status: insightResult.status,
    },
  });
});

// --- Memory endpoints ------------------------------------------------------

app.post("/memory/notes", (req: Request, res: Response) => {
  const { contact_name, note } = req.body ?? {};
  if (typeof contact_name !== "string" || typeof note !== "string") {
    res.status(400).json({ error: "contact_name and note (strings) required" });
    return;
  }
  try {
    const id = addNote(contact_name, note, "auto");
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/memory/notes/manual", (req: Request, res: Response) => {
  const { contact_name, note } = req.body ?? {};
  if (typeof contact_name !== "string" || typeof note !== "string") {
    res.status(400).json({ error: "contact_name and note (strings) required" });
    return;
  }
  try {
    const id = addNote(contact_name, note, "manual");
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// --- Feedback endpoint ------------------------------------------------------
//
// 👍/👎 from the overlay. Appended to voice_profile/feedback.md; init-voice
// folds the corrections into a regenerated voice profile.

app.post("/feedback", (req: Request, res: Response) => {
  const { rating, note, contact, suggestion } = req.body ?? {};
  if (rating !== "up" && rating !== "down") {
    res.status(400).json({ error: "rating must be 'up' or 'down'" });
    return;
  }
  try {
    appendFeedback(
      {
        rating,
        note: typeof note === "string" ? note : undefined,
        contact: typeof contact === "string" ? contact : undefined,
        suggestion: typeof suggestion === "string" ? suggestion : undefined,
      },
      new Date().toISOString(),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Snapshot endpoints ----------------------------------------------------
//
// First-class snapshot workflow: extension POSTs a forensic capture, backend
// writes it to data/snapshots/ with a timestamped filename so it can be
// grep'd / diff'd / replayed when fixing selectors.ts against real DOM.

app.post("/snapshots", (req: Request, res: Response) => {
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({ error: "snapshot body required (JSON object)" });
    return;
  }
  try {
    const result = saveSnapshot(req.body);
    console.log(`[snapshots] saved ${result.filename} (${result.bytes} bytes)`);
    res.json(result);
  } catch (err) {
    console.error("[snapshots] save failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/snapshots", (_req: Request, res: Response) => {
  try {
    res.json({ snapshots: listSnapshots() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/memory/contact/:name", (req: Request, res: Response) => {
  const name = req.params.name;
  const contact = getContact(name);
  if (!contact) {
    res.json({ contact: null, notes: [] });
    return;
  }
  const notes = getNotesFor(name, 50);
  res.json({ contact, notes });
});

const PORT = 8000;

// Hard startup validation. If the runtime voice profile is missing or
// empty, we refuse to boot — silent degradation to "no voice profile
// found" was producing bad replies without anyone noticing.
try {
  validateVoiceProfile();
} catch (err) {
  if (err instanceof VoiceProfileMissingError) {
    console.error("\n" + err.message + "\n");
    process.exit(1);
  }
  throw err;
}

app.listen(PORT, () => {
  ensureWorkspace();
  const voiceChars = getVoice().length;
  console.log(`backend on :${PORT} — voice profile loaded (${voiceChars} chars) — provider=${getProviderName()}`);
});
