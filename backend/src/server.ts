import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { resolve } from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { runLLM, getProviderFor, getProviderName, getProviderNameFor, resetProvider, resetProviderFor } from "./llm/index.js";
import { createOpenAiCompatProvider } from "./llm/openai-compat.js";
import { createAnthropicProvider } from "./llm/anthropic.js";
import { getConfig, reloadConfig, type ProviderName } from "./config.js";
import { writeEnv } from "./envFile.js";
import { PRESETS, findPreset } from "./presets.js";
import {
  loadVoiceProfile,
  validateVoiceProfile,
  voiceProfilePath,
  VoiceProfileMissingError,
} from "./voiceProfile.js";
import { buildPrompt, buildStaticPrefix, type Mode } from "./prompt.js";
import {
  addNote,
  confirmNote,
  deleteContact,
  deleteNote,
  getAllContacts,
  getContact,
  getNotesFor,
  getAllConfirmedNotes,
  getRecentStrategies,
  getStats,
  recordStrategy,
  setFollowupAt,
  updateNote,
  upsertContact,
  upsertProfile,
} from "./memory.js";
import type { IncomingContactProfile } from "./prompt.js";
import { generateInsight } from "./insight.js";
import { ensureWorkspace } from "./workspace.js";
import { listSnapshots, saveSnapshot } from "./snapshots.js";
import { appendFeedback, readFeedback, readFeedbackEntries } from "./feedback.js";
import { appendEdit, editsAsCorrections, readEditEntries } from "./editMining.js";
import { listVersions, restoreVersion, snapshotProfile } from "./voiceVersions.js";
import { tenantOf, DEFAULT_TENANT } from "./tenant.js";
import { resolveTenantByToken } from "./auth.js";
import { exportTenant, purgeTenant } from "./tenantData.js";
import { checkRate } from "./rateLimit.js";
import { dueFollowups } from "./followups.js";
import {
  addContextItem,
  confirmContextItem,
  deleteContextItem,
  getConfirmedContext,
  getContextItems,
  updateContextItem,
  type ContextType,
} from "./context.js";
import {
  SECTION_KEYS,
  adoptExisting,
  compileSections,
  loadSections,
  saveSection,
  type SectionKey,
} from "./voiceSections.js";
import { distill, distillSection } from "./voiceDistill.js";
import { computeStrength } from "./voiceStrength.js";
import { lintProfileText } from "./voiceLint.js";
import { INTERVIEW_QUESTIONS, applyInterview } from "./interview.js";
import { selectAboutMeContext, selectRelevantContext } from "./contextRetrieval.js";
import { findRecurringTopics, findRelationshipStages } from "./memoryPatterns.js";
import { loadCorpusExchanges } from "./corpus.js";

// How many real past exchanges to show the model per draft. Two is enough to
// convey rhythm without crowding the conversation itself out of attention.
const MAX_FEWSHOT_EXAMPLES = 2;

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "suggest",
  "continue_draft",
  "shorter",
  "longer",
  "follow_up",
  "cold_open",
]);

const app = express();

function corsOriginOption(raw: string): string | string[] {
  return raw === "*" ? "*" : raw.split(",").map((s) => s.trim()).filter(Boolean);
}

app.use(cors({ origin: corsOriginOption(getConfig().corsOrigins) }));
app.use(express.json({ limit: "2mb" }));

// Each request's tenant is attached by the auth guard installed below (after
// the public routes). RequestWithTenant + tenant() read it; tenant() falls back
// to the local tenant for the public handlers that run before the guard.
interface RequestWithTenant extends Request {
  tenantId: string;
}
function tenant(req: Request): string {
  return (req as RequestWithTenant).tenantId ?? DEFAULT_TENANT;
}

// PUBLIC surface — registered BEFORE the auth guard so it always loads:
// the management console (contact browser + LLM settings; vanilla HTML/JS, no
// build step) and /health. A hosted user can thus open the dashboard to paste
// their token, and health checks need no credentials. API routes use distinct
// prefixes (/memory, /config, /analyze) so static serving can't shadow them.
app.use(express.static(resolve(process.cwd(), "public")));

// Per-tenant voice cache. Each tenant's compiled profile is loaded once and
// memoised; the local tenant is the only one on a single-user install.
const voiceCache = new Map<string, string>();
function getVoice(tenantId: string): string {
  let v = voiceCache.get(tenantId);
  if (v === undefined) {
    v = loadVoiceProfile(tenantId);
    voiceCache.set(tenantId, v);
  }
  return v;
}

// Prewarm a tenant's prompt cache: writes the (byte-stable) voice prefix into the
// provider's cache so the first real draft is a cache READ, not a cold write.
// A no-op for providers that can't be primed (gemini-cli / openai-compat don't
// implement `warm`). Best-effort and never throws — warm-up must not break a
// request or boot. De-duped per tenant while in flight so overlay-open spam can't
// fan out into N concurrent prewarms.
const warmInFlight = new Set<string>();
async function warmTenant(tenantId: string): Promise<void> {
  if (warmInFlight.has(tenantId)) return;
  const provider = getProviderFor(tenantId);
  if (!provider.warm) return;
  warmInFlight.add(tenantId);
  try {
    await provider.warm({ tenantId, staticPrefix: buildStaticPrefix(getVoice(tenantId)) });
  } catch {
    /* provider.warm already swallows; this guards getVoice/provider resolution */
  } finally {
    warmInFlight.delete(tenantId);
  }
}

app.get("/health", (req: Request, res: Response) => {
  const voiceChars = getVoice(tenant(req)).length;
  res.json({
    ok: true,
    voiceProfileChars: voiceChars,
    voiceProfileOk: voiceChars > 40,
    provider: getProviderName(),
    requireAuth: getConfig().requireAuth,
    prefetch: getConfig().prefetch,
  });
});

// --- Auth guard ------------------------------------------------------------
//
// Everything below requires a resolved tenant. A request authenticates with
// `Authorization: Bearer <token>` → that tenant. In local mode (the default,
// requireAuth=false) an unauthenticated request acts as the 'local' tenant,
// optionally narrowed by the X-Comms-Tenant dev header; in hosted mode
// (COMMS_REQUIRE_AUTH=1) it is rejected with 401. A presented-but-unknown token
// is always rejected, even in local mode.
app.use((req: Request, res: Response, next: NextFunction) => {
  const header = req.header("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer) {
    const tid = resolveTenantByToken(bearer);
    if (!tid) {
      res.status(401).json({ error: "invalid or revoked token" });
      return;
    }
    (req as RequestWithTenant).tenantId = tid;
    next();
    return;
  }
  if (getConfig().requireAuth) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  (req as RequestWithTenant).tenantId = tenantOf(req);
  next();
});

app.post("/analyze", async (req: Request, res: Response) => {
  const t = tenant(req);
  const rl = checkRate(t, getConfig().rateLimitPerMin);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    res.status(429).json({ error: `rate limit exceeded — retry in ${rl.retryAfterSec}s` });
    return;
  }

  const body = req.body ?? {};
  const ctx = body;
  const messageCount = Array.isArray(ctx?.messages) ? ctx.messages.length : 0;
  const draftLen = (ctx?.current_draft ?? "").length;

  const rawMode = typeof body.mode === "string" ? body.mode : "suggest";
  const mode: Mode = VALID_MODES.has(rawMode as Mode) ? (rawMode as Mode) : "suggest";
  const seedText: string = typeof body.seed_text === "string" ? body.seed_text : "";
  const steer: string = typeof body.steer === "string" ? body.steer : "";
  // "Another take": a draft the user already has, to diverge from. Trusted —
  // it's our own prior output, kept on screen by the user (see prompt.ts).
  const variationOf: string = typeof body.variation_of === "string" ? body.variation_of : "";

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
  } else if (mode === "cold_open") {
    // A first message legitimately has no conversation — the contact's profile
    // is the only grounding, so require it instead of messages/draft.
    const hasProfile = !!ctx?.contact_profile && typeof ctx.contact_profile === "object";
    if (!hasProfile) {
      res.status(400).json({ error: "mode 'cold_open' requires a contact_profile to draft from" });
      return;
    }
  } else if (messageCount === 0 && draftLen === 0) {
    res.status(400).json({ error: "no messages and no draft — nothing to suggest from" });
    return;
  }

  // Read memory for this contact and inject into prompt.
  let existingNoteBodies: string[] = [];
  if (contactName) {
    upsertContact(t, contactName, threadUrl);
    existingNoteBodies = getNotesFor(t, contactName).map((n) => n.body);

    // Persist the contact profile (if attached). The extension caches profiles
    // client-side and re-attaches them on every /analyze; we mirror it here so
    // the data survives across browser profile resets and is queryable.
    const incomingProfile = ctx?.contact_profile as IncomingContactProfile | null | undefined;
    if (incomingProfile && typeof incomingProfile === "object") {
      try {
        upsertProfile(t, contactName, incomingProfile);
      } catch (err) {
        console.warn("[analyze] upsertProfile failed:", (err as Error).message);
      }
    }
  }

  // Trusted "ABOUT ME" substance, but RANKED to this contact: foundational items
  // (bio/achievement/looking_for) are always kept, while PROJECT items — which
  // can number in the dozens — are trimmed to the few most relevant by term
  // overlap with the contact's profile + recent messages, rather than dumping all
  // of them (bloat + dilution). See selectAboutMeContext.
  const aboutSignal = [
    ctx?.contact_profile?.headline,
    ctx?.contact_profile?.role,
    ctx?.contact_profile?.company,
    ctx?.contact_profile?.about,
    (ctx?.contact_profile?.skills ?? []).join(" "),
    (ctx?.contact_profile?.experience ?? []).map((e: { title?: string; company?: string }) => `${e.title ?? ""} ${e.company ?? ""}`).join(" "),
    (Array.isArray(ctx?.messages) ? ctx.messages.slice(-10) : []).map((m: { text?: string }) => m.text ?? "").join(" "),
  ]
    .filter(Boolean)
    .join(" ");
  const aboutMe = selectAboutMeContext(getConfirmedContext(t), aboutSignal).map((c) => ({
    type: c.type,
    title: c.title,
    body: c.body,
  }));

  // Few-shot grounding (ROADMAP C2): the 2 past exchanges most on-topic for this
  // contact, ranked against the SAME signal as ABOUT ME. Only gemini-cli could
  // reach the corpus before (it greps its sandbox copy); injecting the top few
  // gives every provider the same floor. Empty when the tenant has no corpus.
  const examples = selectRelevantContext(loadCorpusExchanges(t), aboutSignal, {
    max: MAX_FEWSHOT_EXAMPLES,
  }).map((e) => ({ title: e.title, body: e.body }));

  const { instruction, context, staticPrefix, resolvedMode, transcript } = buildPrompt({
    ctx,
    voiceProfile: getVoice(t),
    mode,
    seedText,
    steer,
    existingNotes: existingNoteBodies,
    aboutMe,
    examples,
    variationOf,
  });

  // Explainability ("why did it write this?"): the deterministic inputs that
  // actually shaped this draft — which ABOUT ME items were injected, how many
  // confirmed memory notes, and the voice-profile size. Returned in stats so the
  // overlay can show "what shaped this" without guessing.
  const explain = {
    context_items: aboutMe.map((c) => ({ type: c.type, title: c.title })),
    notes_used: existingNoteBodies.length,
    voice_chars: getVoice(t).length,
    examples_used: examples.map((e) => e.title),
  };

  // Insight runs only on a real conversation (shorter/longer are pure rewrites).
  const runInsight = !!contactName && (mode === "suggest" || mode === "continue_draft" || mode === "follow_up");
  const computeInsight = () =>
    runInsight
      ? generateInsight({
          contactName,
          transcript,
          existingNotes: getNotesFor(t, contactName),
          todayIso: new Date().toISOString().slice(0, 10),
          tenantId: t,
        })
      : Promise.resolve({ memory_proposal: null, strategy: null });
  const persistStrategy = (ins: { strategy: { text: string; suggested_followup_at: string | null } | null }) => {
    if (ins.strategy && contactName) {
      recordStrategy(t, contactName, ins.strategy.text, ins.strategy.suggested_followup_at);
      if (ins.strategy.suggested_followup_at) setFollowupAt(t, contactName, ins.strategy.suggested_followup_at);
    }
  };

  // --- Streaming variant (SSE). The client opts in with `stream: true` (or an
  // `Accept: text/event-stream` header) and the provider must support runStream.
  // Events: token* → reply_done → insight → done (or error). Insight runs AFTER
  // the reply is fully streamed, so the draft is never held up by it (Phase A).
  const wantStream =
    (req.body as { stream?: unknown })?.stream === true ||
    (req.header("accept") || "").includes("text/event-stream");
  const provider = getProviderFor(t);
  if (wantStream && provider.runStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const reply = await provider.runStream(instruction, context, {
        tenantId: t,
        staticPrefix,
        onToken: (tok) => sse("token", { t: tok }),
      });
      sse("reply_done", {
        suggested_reply: reply.text,
        stats: { requested_mode: mode, resolved_mode: resolvedMode, llm_ms: reply.durationMs, provider: getProviderNameFor(t), explain },
      });
      try {
        const ins = await computeInsight();
        persistStrategy(ins);
        sse("insight", { memory_proposal: ins.memory_proposal, strategy: ins.strategy });
      } catch (err) {
        console.warn("[analyze:stream] insight failed:", (err as Error)?.message);
        sse("insight", { memory_proposal: null, strategy: null });
      }
      sse("done", {});
    } catch (err) {
      console.error("[analyze:stream] reply failed:", err);
      sse("error", { error: (err as Error)?.message ?? "reply failed" });
    } finally {
      res.end();
    }
    return;
  }

  // --- Non-streaming (JSON) path: reply + insight in parallel.
  const replyPromise = runLLM(instruction, context, { tenantId: t, staticPrefix });
  const insightPromise = computeInsight();

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

  persistStrategy(insight);

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
      provider: getProviderNameFor(t),
      had_existing_notes: existingNoteBodies.length,
      insight_status: insightResult.status,
      explain,
    },
  });
});

// Cache prewarm — the overlay pings this on open so the voice prefix is hot
// before the user clicks Suggest. Returns immediately (warm runs in the
// background); `warmable` tells the caller whether the active provider can be
// primed at all, so the overlay needn't ping a provider that can't benefit.
app.post("/warm", (req: Request, res: Response) => {
  const t = tenant(req);
  const warmable = !!getProviderFor(t).warm;
  if (warmable) void warmTenant(t);
  res.json({ ok: true, warmable, provider: getProviderNameFor(t) });
});

// --- Memory endpoints ------------------------------------------------------

app.post("/memory/notes", (req: Request, res: Response) => {
  const { contact_name, note } = req.body ?? {};
  if (typeof contact_name !== "string" || typeof note !== "string") {
    res.status(400).json({ error: "contact_name and note (strings) required" });
    return;
  }
  try {
    const id = addNote(tenant(req), contact_name, note, "auto");
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
    const id = addNote(tenant(req), contact_name, note, "manual");
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
  const { rating, note, contact, suggestion, section } = req.body ?? {};
  if (rating !== "up" && rating !== "down") {
    res.status(400).json({ error: "rating must be 'up' or 'down'" });
    return;
  }
  // A structured 👎 chip names the voice section it's about. Validate against the
  // known keys so a bad value can't pollute the feedback log (and later distill).
  if (section !== undefined && !SECTION_KEYS.includes(section as SectionKey)) {
    res.status(400).json({ error: `section must be one of: ${SECTION_KEYS.join(", ")}` });
    return;
  }
  try {
    appendFeedback(
      tenant(req),
      {
        rating,
        note: typeof note === "string" ? note : undefined,
        contact: typeof contact === "string" ? contact : undefined,
        suggestion: typeof suggestion === "string" ? suggestion : undefined,
        section: typeof section === "string" ? section : undefined,
      },
      new Date().toISOString(),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Edit-mining capture (opt-in, set in the popup): the overlay POSTs the diff
// between a suggested draft and what the user actually copied. Stored as a
// candidate correction that `Apply corrections` later folds into the profile.
app.post("/voice/edits", (req: Request, res: Response) => {
  const { before, after, contact } = req.body ?? {};
  if (typeof before !== "string" || typeof after !== "string" || !before.trim() || !after.trim()) {
    res.status(400).json({ error: "before and after (non-empty strings) required" });
    return;
  }
  if (before.trim() === after.trim()) {
    res.status(400).json({ error: "before and after are identical — nothing to learn" });
    return;
  }
  try {
    appendEdit(
      tenant(req),
      { before, after, contact: typeof contact === "string" ? contact : undefined },
      new Date().toISOString(),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Voice lint (deterministic, no LLM): flag where a draft uses words the user's
// own voice profile says to avoid. The overlay calls this as the user reads/edits
// a draft and surfaces hits as a gentle heads-up.
app.post("/voice/lint", (req: Request, res: Response) => {
  const { text } = req.body ?? {};
  if (typeof text !== "string") {
    res.status(400).json({ error: "text (string) required" });
    return;
  }
  res.json({ violations: lintProfileText(getVoice(tenant(req)), text) });
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
    const result = saveSnapshot(tenant(req), req.body);
    console.log(`[snapshots] saved ${result.filename} (${result.bytes} bytes)`);
    res.json(result);
  } catch (err) {
    console.error("[snapshots] save failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/snapshots", (req: Request, res: Response) => {
  try {
    res.json({ snapshots: listSnapshots(tenant(req)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Follow-ups that are actually due ---------------------------------------
//
// The dates have always been stored; nothing ever noticed when one arrived.
// The extension polls this on an alarm and turns the count into a badge, so a
// follow-up reaches you without your having to remember to go and look.
app.get("/memory/followups", (req: Request, res: Response) => {
  try {
    const due = dueFollowups(getAllContacts(tenant(req)), new Date().toISOString());
    res.json({ followups: due, count: due.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/memory/contacts", (req: Request, res: Response) => {
  try {
    res.json({ contacts: getAllContacts(tenant(req)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Cross-conversation patterns (ROADMAP C4) -------------------------------
//
// READ-ONLY, and deliberately so. These proposals are machine-derived, and
// prompt.ts trusts memory notes and ABOUT ME items only because a user
// confirmed each one. So nothing here writes: the dashboard renders the
// proposals and the user adopts one through the EXISTING gates — POST /context
// for a theme, POST /memory/notes/manual for a relationship hint. Adopting IS
// the confirmation, which is why there's no separate confirm step and no
// unconfirmed rows piling up on every dashboard visit.
app.get("/memory/patterns", (req: Request, res: Response) => {
  const t = tenant(req);
  try {
    const input = {
      notes: getAllConfirmedNotes(t).map((n) => ({ contact_name: n.contact_name, body: n.body })),
      strategies: getRecentStrategies(t, 500).map((s) => ({
        contact_name: s.contact_name,
        text: s.text,
      })),
    };
    res.json({
      topics: findRecurringTopics(input),
      relationships: findRelationshipStages(input),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/memory/strategies", (req: Request, res: Response) => {
  const limit = Number(req.query.limit);
  try {
    res.json({ strategies: getRecentStrategies(tenant(req), Number.isFinite(limit) ? limit : 50) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Overview / stats ------------------------------------------------------

app.get("/stats", (req: Request, res: Response) => {
  try {
    const stats = getStats(tenant(req), new Date().toISOString());
    const voiceChars = getVoice(tenant(req)).length;
    res.json({
      ...stats,
      snapshots: listSnapshots(tenant(req)).length,
      feedback: readFeedbackEntries(tenant(req)).length,
      edits: readEditEntries(tenant(req)).length,
      provider: getProviderName(),
      voice_profile_chars: voiceChars,
      voice_profile_ok: voiceChars > 40,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Voice profile (read-only view) ----------------------------------------

app.get("/voice", (req: Request, res: Response) => {
  try {
    const content = loadVoiceProfile(tenant(req));
    const path = voiceProfilePath(tenant(req));
    let updatedAt: string | null = null;
    if (existsSync(path)) {
      try { updatedAt = statSync(path).mtime.toISOString(); } catch { /* ignore */ }
    }
    res.json({
      content,
      chars: content.length,
      ok: content.length > 40,
      updated_at: updatedAt,
      feedback: readFeedbackEntries(tenant(req)),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Personal context ("ABOUT ME": projects / achievements / bio / goals) ---
//
// Trusted substance the assistant can reference in replies (esp. cold-opens).
// Only confirmed items are injected into prompts (see getConfirmedContext); the
// confirm gate mirrors memory notes.

const CONTEXT_TYPES: ReadonlySet<string> = new Set(["project", "achievement", "bio", "looking_for"]);

app.get("/context", (req: Request, res: Response) => {
  try {
    const items = getContextItems(tenant(req), { includeUnconfirmed: true });
    const grouped: Record<string, typeof items> = {};
    for (const it of items) (grouped[it.type] ??= []).push(it);
    res.json({ items, grouped });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/context", (req: Request, res: Response) => {
  const { type, title, body, tags, confirmed } = req.body ?? {};
  if (!CONTEXT_TYPES.has(type)) {
    res.status(400).json({ error: "type must be one of project|achievement|bio|looking_for" });
    return;
  }
  try {
    const id = addContextItem(tenant(req), {
      type: type as ContextType,
      title: typeof title === "string" ? title : "",
      body: typeof body === "string" ? body : "",
      tags: Array.isArray(tags) ? tags.filter((t) => typeof t === "string") : undefined,
      confirmed: confirmed === 0 ? 0 : 1,
    });
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put("/context/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  const { title, body, tags } = req.body ?? {};
  try {
    const ok = updateContextItem(tenant(req), id, {
      title: typeof title === "string" ? title : undefined,
      body: typeof body === "string" ? body : undefined,
      tags: Array.isArray(tags) ? tags.filter((t) => typeof t === "string") : undefined,
    });
    if (!ok) {
      res.status(404).json({ error: "context item not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete("/context/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  const deleted = deleteContextItem(tenant(req), id);
  if (!deleted) {
    res.status(404).json({ error: "context item not found" });
    return;
  }
  res.json({ ok: true, deleted });
});

app.post("/context/:id/confirm", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  const ok = confirmContextItem(tenant(req), id);
  res.json({ ok });
});

/**
 * Cold-start (voice-onboarding §8): seed "ABOUT ME" from the user's OWN scraped
 * LinkedIn profile. The extension posts the profile it extracted; we map it to
 * PROPOSED (confirmed=0) context items — headline/about → a bio, recent
 * experience → projects — for the user to review and confirm in the dashboard.
 * Proposed, not trusted, mirrors the memory-note trust gate (auto-imported
 * content isn't injected until the user signs off).
 */
function contextItemsFromProfile(
  profile: IncomingContactProfile,
): Array<{ type: ContextType; title: string; body: string; confirmed: 0 }> {
  const items: Array<{ type: ContextType; title: string; body: string; confirmed: 0 }> = [];
  const about = (profile.about ?? "").trim();
  const headline = (profile.headline ?? "").trim();
  if (about || headline) {
    items.push({ type: "bio", title: headline || "About me", body: about || headline, confirmed: 0 });
  }
  for (const e of (profile.experience ?? []).slice(0, 4)) {
    const title = [e.title, e.company].filter(Boolean).join(" @ ");
    if (!title) continue;
    items.push({ type: "project", title, body: e.duration ? `Experience · ${e.duration}` : "Experience", confirmed: 0 });
  }
  return items;
}

app.post("/onboarding/from-linkedin", (req: Request, res: Response) => {
  const profile = req.body?.profile as IncomingContactProfile | undefined;
  if (!profile || typeof profile !== "object" || typeof profile.name !== "string" || !profile.name.trim()) {
    res.status(400).json({ error: "a scraped profile with a name is required" });
    return;
  }
  try {
    const t = tenant(req);
    let created = 0;
    for (const it of contextItemsFromProfile(profile)) {
      try {
        addContextItem(t, it);
        created++;
      } catch {
        /* skip an item that fails validation rather than fail the whole import */
      }
    }
    res.json({ ok: true, created });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Guided interview (voice-onboarding §8): GET the questions, POST the answers.
// Answers map deterministically to voice sections + proposed context items.
app.get("/onboarding/interview", (_req: Request, res: Response) => {
  res.json({ questions: INTERVIEW_QUESTIONS });
});

app.post("/onboarding/interview", (req: Request, res: Response) => {
  const answers = req.body?.answers;
  if (!answers || typeof answers !== "object") {
    res.status(400).json({ error: "an answers object is required" });
    return;
  }
  try {
    const result = applyInterview(tenant(req), answers as Record<string, string>);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Voice authoring (sections + in-browser distill, compiles to runtime file) ---

app.get("/voice/sections", (req: Request, res: Response) => {
  const t = tenant(req);
  try {
    // No sections yet but a compiled profile exists → adopt it so nothing is lost.
    const doc = loadSections(t) ?? adoptExisting(t);
    res.json({ keys: SECTION_KEYS, sections: doc.sections, updated_at: doc.updatedAt });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/voice/sections/:key", (req: Request, res: Response) => {
  const key = req.params.key as SectionKey;
  if (!SECTION_KEYS.includes(key)) {
    res.status(400).json({ error: `unknown section '${key}'` });
    return;
  }
  const { body } = req.body ?? {};
  if (typeof body !== "string") {
    res.status(400).json({ error: "body (string) required" });
    return;
  }
  try {
    saveSection(tenant(req), key, body, "manual");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/voice/compile", (req: Request, res: Response) => {
  const t = tenant(req);
  try {
    snapshotProfile(t, "compile"); // undo point before overwriting the runtime file
    const compiled = compileSections(t);
    voiceCache.delete(t); // the runtime artifact changed
    res.json({ ok: true, chars: compiled.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Regenerate ONE voice section from the corpus (per-section "Regenerate"). */
app.post("/voice/sections/:key/regenerate", async (req: Request, res: Response) => {
  const key = req.params.key as SectionKey;
  if (!SECTION_KEYS.includes(key)) {
    res.status(400).json({ error: `unknown section '${key}'` });
    return;
  }
  try {
    const body = await distillSection(tenant(req), key);
    saveSection(tenant(req), key, body, "distilled");
    res.json({ ok: true, body });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Voice "strength" — a single score + breakdown + the single best next thing to
 * add. Drives onboarding and a quality gate. Pure computation over the current
 * profile state (no LLM).
 */
app.get("/voice/strength", (req: Request, res: Response) => {
  const t = tenant(req);
  try {
    const doc = loadSections(t);
    const sectionsFilled = doc
      ? SECTION_KEYS.filter((k) => (doc.sections[k]?.body ?? "").trim().length > 0).length
      : 0;
    const strength = computeStrength({
      sectionsFilled,
      sectionsTotal: SECTION_KEYS.length,
      profileChars: getVoice(t).length,
      contextConfirmed: getConfirmedContext(t).length,
      feedbackCount: readFeedbackEntries(t).length,
    });
    res.json(strength);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Apply the 👍/👎 corrections collected in feedback.md to the profile in one
 * click (Phase 5 feedback loop). Re-distills from the corpus with the
 * corrections folded in (they override the samples where they conflict), writes
 * the runtime profile, and busts the cache.
 */
app.post("/voice/feedback/apply", async (req: Request, res: Response) => {
  const t = tenant(req);
  const feedback = readFeedback(t);
  const edits = editsAsCorrections(t);
  if (!feedback.trim() && !edits.trim()) {
    res.status(400).json({
      error: "no corrections to apply yet — use 👍/👎 in the overlay, or enable edit-mining",
    });
    return;
  }
  // Combine 👍/👎 notes and captured hand-edits into one corrections block.
  const corrections = [feedback, edits].filter((s) => s.trim()).join("\n\n");
  try {
    const markdown = await distill(t, { feedback: corrections });
    snapshotProfile(t, "apply"); // undo point before overwriting
    writeFileSync(voiceProfilePath(t), markdown, "utf-8");
    voiceCache.delete(t);
    res.json({ ok: true, chars: markdown.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Distill a voice profile from pasted messages (the in-browser `init-voice`).
 * Writes the result straight to the runtime strategy_analysis.md and busts the
 * voice cache. Body: { corpusText?: string } — falls back to raw_corpus/ on disk.
 */
app.post("/voice/distill", async (req: Request, res: Response) => {
  const t = tenant(req);
  const corpusText = typeof req.body?.corpusText === "string" ? req.body.corpusText : undefined;
  try {
    const markdown = await distill(t, { corpusText });
    snapshotProfile(t, "distill"); // undo point before overwriting
    writeFileSync(voiceProfilePath(t), markdown, "utf-8");
    voiceCache.delete(t);
    res.json({ ok: true, chars: markdown.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Voice version history (Phase 5 safety net): list snapshots and revert. Each
// destructive op (compile / distill / apply) snapshots the prior profile first;
// a restore snapshots the current one ("pre-restore") so it's itself undoable.
app.get("/voice/versions", (req: Request, res: Response) => {
  res.json({ versions: listVersions(tenant(req)) });
});

app.post("/voice/versions/:id/restore", (req: Request, res: Response) => {
  const t = tenant(req);
  const id = req.params.id;
  snapshotProfile(t, "pre-restore"); // keep an undo point for the restore itself
  if (!restoreVersion(t, id)) {
    res.status(404).json({ error: "unknown version id" });
    return;
  }
  voiceCache.delete(t); // runtime artifact changed
  res.json({ ok: true });
});

// --- Data lifecycle (H5): portability + erasure --------------------------

/** Full export of the caller's tenant data (GDPR-style portability). */
app.get("/export", (req: Request, res: Response) => {
  try {
    res.json(exportTenant(tenant(req), new Date().toISOString()));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Erase ALL of the caller's tenant data. Destructive and irreversible, so the
 * body must echo the tenant id: { "confirm": "<tenantId>" }. Also evicts the
 * tenant's cached voice + provider so nothing stale survives in memory.
 */
app.post("/data/purge", (req: Request, res: Response) => {
  const t = tenant(req);
  const confirm = (req.body?.confirm ?? "").toString();
  if (confirm !== t) {
    res.status(400).json({ error: `to confirm erasure, send { "confirm": "${t}" }` });
    return;
  }
  try {
    const purged = purgeTenant(t);
    voiceCache.delete(t);
    resetProviderFor(t);
    console.log(`[data] purged tenant '${t}':`, purged);
    res.json({ ok: true, purged });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/memory/contact/:name", (req: Request, res: Response) => {
  const name = req.params.name;
  const contact = getContact(tenant(req), name);
  if (!contact) {
    res.json({ contact: null, notes: [] });
    return;
  }
  // The console shows pending (unconfirmed) notes too, so the user can confirm
  // or discard them from one place.
  const notes = getNotesFor(tenant(req), name, { includeUnconfirmed: true, limit: 200 });
  res.json({ contact, notes });
});

app.delete("/memory/contact/:name", (req: Request, res: Response) => {
  const deleted = deleteContact(tenant(req), req.params.name);
  res.json({ ok: true, deleted });
});

app.delete("/memory/notes/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  const deleted = deleteNote(tenant(req), id);
  if (!deleted) {
    res.status(404).json({ error: "note not found" });
    return;
  }
  res.json({ ok: true, deleted });
});

app.patch("/memory/notes/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { body } = req.body ?? {};
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  if (typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body (non-empty string) required" });
    return;
  }
  try {
    const updated = updateNote(tenant(req), id, body);
    if (!updated) {
      res.status(404).json({ error: "note not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/memory/notes/:id/confirm", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  confirmNote(tenant(req), id);
  res.json({ ok: true });
});

// --- LLM provider settings -------------------------------------------------
//
// Lets the dashboard switch provider / model / key live, without hand-editing
// .env or restarting. POST /config writes .env (for persistence) AND mutates
// process.env (for the live effect — config.ts's loader only fills keys that
// are MISSING from process.env), then busts the config + provider caches.

function maskKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 4) return "****";
  return "****" + key.slice(-4);
}

function buildConfigPayload() {
  const cfg = getConfig();
  return {
    provider: cfg.provider,
    openai: {
      baseUrl: cfg.openai.baseUrl,
      model: cfg.openai.model,
      temperature: cfg.openai.temperature ?? null,
      apiKeyMasked: maskKey(cfg.openai.apiKey),
    },
    anthropic: {
      model: cfg.anthropic.model,
      apiKeyMasked: maskKey(cfg.anthropic.apiKey),
    },
    timeoutMs: cfg.timeoutMs,
    presets: PRESETS,
  };
}

/** Resolve a posted settings body into a flat {provider, baseUrl, model, apiKey, temperature, timeoutMs}. */
function resolveSettings(body: Record<string, unknown>): {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number | undefined;
  timeoutMs: number | undefined;
  error?: undefined;
} | { error: string } {
  const preset = typeof body.preset === "string" ? findPreset(body.preset) : undefined;
  let provider: ProviderName | undefined = preset?.provider;
  if (
    !provider &&
    (body.provider === "openai-compat" || body.provider === "gemini-cli" || body.provider === "anthropic")
  ) {
    provider = body.provider;
  }
  if (!provider) return { error: "unknown provider or preset" };

  const cfg = getConfig();
  const incomingKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  // Fall back to the provider's own stored key/model when the body omits them.
  const storedKey = provider === "anthropic" ? cfg.anthropic.apiKey : cfg.openai.apiKey;
  const apiKey = incomingKey || storedKey; // blank → keep existing
  const storedModel = provider === "anthropic" ? cfg.anthropic.model : cfg.openai.model;

  const baseUrlRaw =
    typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl.trim()
      : preset?.baseUrl || cfg.openai.baseUrl;
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : preset?.models?.[0] || storedModel;

  let temperature: number | undefined;
  if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
    temperature = body.temperature;
  }
  let timeoutMs: number | undefined;
  if (typeof body.timeoutMs === "number" && Number.isInteger(body.timeoutMs) && body.timeoutMs > 0) {
    timeoutMs = body.timeoutMs;
  }

  if (provider === "openai-compat") {
    if (!baseUrl) return { error: "baseUrl required for an HTTP provider" };
    if (preset?.keyRequired && !apiKey) return { error: `${preset.label} requires an API key` };
  }
  if (provider === "anthropic" && !apiKey) {
    return { error: "Anthropic (native) requires an API key" };
  }

  return { provider, baseUrl, model, apiKey, temperature, timeoutMs };
}

app.get("/config", (_req: Request, res: Response) => {
  res.json(buildConfigPayload());
});

app.post("/config", (req: Request, res: Response) => {
  const resolved = resolveSettings(req.body ?? {});
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }

  const updates: Record<string, string> = { LLM_PROVIDER: resolved.provider };
  const suppliedKey =
    typeof req.body?.apiKey === "string" && req.body.apiKey.trim() ? req.body.apiKey.trim() : "";
  if (resolved.provider === "openai-compat") {
    updates.OPENAI_BASE_URL = resolved.baseUrl;
    updates.OPENAI_MODEL = resolved.model;
    // Only write the key if the user actually supplied one — never clobber a
    // stored key with empty.
    if (suppliedKey) updates.OPENAI_API_KEY = suppliedKey;
    if (resolved.temperature !== undefined) updates.OPENAI_TEMPERATURE = String(resolved.temperature);
  } else if (resolved.provider === "anthropic") {
    updates.ANTHROPIC_MODEL = resolved.model;
    if (suppliedKey) updates.ANTHROPIC_API_KEY = suppliedKey;
  }
  if (resolved.timeoutMs !== undefined) updates.LLM_TIMEOUT_MS = String(resolved.timeoutMs);

  try {
    writeEnv(updates);
  } catch (err) {
    res.status(500).json({ error: `failed to persist .env: ${(err as Error).message}` });
    return;
  }
  // Live effect: mutate process.env, then bust both caches.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  reloadConfig();
  resetProvider();

  console.log(`[config] provider=${resolved.provider} model=${resolved.model} (applied live)`);
  res.json(buildConfigPayload());
});

app.post("/config/test", async (req: Request, res: Response) => {
  const resolved = resolveSettings(req.body ?? {});
  if ("error" in resolved) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  if (resolved.provider === "gemini-cli") {
    res.json({
      ok: true,
      ms: 0,
      note: "gemini-cli runs locally — not tested remotely. Click Suggest in the overlay to verify.",
    });
    return;
  }
  const probe =
    resolved.provider === "anthropic"
      ? createAnthropicProvider({ apiKey: resolved.apiKey, model: resolved.model, timeoutMs: 20_000 })
      : createOpenAiCompatProvider({
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          model: resolved.model,
          temperature: undefined,
          timeoutMs: 20_000,
        });
  const start = Date.now();
  try {
    await probe.run("Reply with the single word OK.", "ping");
    res.json({ ok: true, ms: Date.now() - start });
  } catch (err) {
    res.json({ ok: false, ms: Date.now() - start, error: (err as Error).message });
  }
});

const PORT = Number(process.env.PORT) || 8000;
// Bind host: loopback by default (local install), 0.0.0.0 for a hosted
// deployment. See the loopback rationale at the listen() call below.
const HOST = process.env.COMMS_BIND_HOST || "127.0.0.1";

// Hard startup validation (local mode only). If the local tenant's voice
// profile is missing or empty we refuse to boot — silent degradation to "no
// voice profile found" was producing bad replies without anyone noticing. In
// hosted mode (requireAuth) there is no single local tenant — each tenant
// brings its own voice — so a missing local profile is not a boot blocker.
if (!getConfig().requireAuth) {
  try {
    validateVoiceProfile();
  } catch (err) {
    if (err instanceof VoiceProfileMissingError) {
      console.error("\n" + err.message + "\n");
      process.exit(1);
    }
    throw err;
  }
}

// Bind to loopback by default: the console exposes contact data and mutating
// routes (delete, config-write), so on a local install we keep them off the
// network. A hosted deployment sets COMMS_BIND_HOST=0.0.0.0 and relies on
// bearer-token auth (COMMS_REQUIRE_AUTH=1) + TLS at the edge instead.
app.listen(PORT, HOST, () => {
  ensureWorkspace(DEFAULT_TENANT);
  const voiceChars = getVoice(DEFAULT_TENANT).length;
  console.log(`backend on http://${HOST}:${PORT} — voice profile loaded (${voiceChars} chars) — provider=${getProviderName()}`);
  console.log(`console: http://${HOST}:${PORT}/`);
  // Prewarm the local tenant's cache on boot so the very first draft is a cache
  // read. No-op (and silent) unless the active provider supports priming.
  void warmTenant(DEFAULT_TENANT);
});
