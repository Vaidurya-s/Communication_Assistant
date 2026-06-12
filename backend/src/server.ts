import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { runLLM, getProviderName, getProviderNameFor, resetProvider, resetProviderFor } from "./llm/index.js";
import { createOpenAiCompatProvider } from "./llm/openai-compat.js";
import { getConfig, reloadConfig, type ProviderName } from "./config.js";
import { writeEnv } from "./envFile.js";
import { PRESETS, findPreset } from "./presets.js";
import {
  loadVoiceProfile,
  validateVoiceProfile,
  voiceProfilePath,
  VoiceProfileMissingError,
} from "./voiceProfile.js";
import { buildPrompt, type Mode } from "./prompt.js";
import {
  addNote,
  confirmNote,
  deleteContact,
  deleteNote,
  getAllContacts,
  getContact,
  getNotesFor,
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
import { appendFeedback, readFeedbackEntries } from "./feedback.js";
import { tenantOf, DEFAULT_TENANT } from "./tenant.js";
import { resolveTenantByToken } from "./auth.js";
import { exportTenant, purgeTenant } from "./tenantData.js";
import { checkRate } from "./rateLimit.js";

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "suggest",
  "continue_draft",
  "shorter",
  "longer",
  "follow_up",
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

app.get("/health", (req: Request, res: Response) => {
  const voiceChars = getVoice(tenant(req)).length;
  res.json({
    ok: true,
    voiceProfileChars: voiceChars,
    voiceProfileOk: voiceChars > 40,
    provider: getProviderName(),
    requireAuth: getConfig().requireAuth,
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

  const { instruction, context, resolvedMode, transcript } = buildPrompt({
    ctx,
    voiceProfile: getVoice(t),
    mode,
    seedText,
    steer,
    existingNotes: existingNoteBodies,
  });

  // Fire reply + insight in parallel. Insight is run on the FULL transcript
  // regardless of mode (it always benefits from full context).
  const replyPromise = runLLM(instruction, context, { tenantId: t });

  // Only run insight when we have a real conversation to analyze. shorter/formal
  // are pure rewrites — they shouldn't trigger memory updates.
  const runInsight = contactName && (mode === "suggest" || mode === "continue_draft" || mode === "follow_up");
  const insightPromise = runInsight
    ? generateInsight({
        contactName,
        transcript,
        existingNotes: getNotesFor(t, contactName),
        todayIso: new Date().toISOString().slice(0, 10),
        tenantId: t,
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
    recordStrategy(t, contactName, insight.strategy.text, insight.strategy.suggested_followup_at);
    if (insight.strategy.suggested_followup_at) {
      setFollowupAt(t, contactName, insight.strategy.suggested_followup_at);
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
      provider: getProviderNameFor(t),
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
  const { rating, note, contact, suggestion } = req.body ?? {};
  if (rating !== "up" && rating !== "down") {
    res.status(400).json({ error: "rating must be 'up' or 'down'" });
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

app.get("/memory/contacts", (req: Request, res: Response) => {
  try {
    res.json({ contacts: getAllContacts(tenant(req)) });
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
  if (!provider && (body.provider === "openai-compat" || body.provider === "gemini-cli")) {
    provider = body.provider;
  }
  if (!provider) return { error: "unknown provider or preset" };

  const cfg = getConfig();
  const incomingKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey = incomingKey || cfg.openai.apiKey; // blank → keep existing

  const baseUrlRaw =
    typeof body.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl.trim()
      : preset?.baseUrl || cfg.openai.baseUrl;
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : preset?.models?.[0] || cfg.openai.model;

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
  if (resolved.provider === "openai-compat") {
    updates.OPENAI_BASE_URL = resolved.baseUrl;
    updates.OPENAI_MODEL = resolved.model;
    // Only write the key if the user actually supplied one — never clobber a
    // stored key with empty.
    if (typeof req.body?.apiKey === "string" && req.body.apiKey.trim()) {
      updates.OPENAI_API_KEY = req.body.apiKey.trim();
    }
    if (resolved.temperature !== undefined) updates.OPENAI_TEMPERATURE = String(resolved.temperature);
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
  const probe = createOpenAiCompatProvider({
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
});
