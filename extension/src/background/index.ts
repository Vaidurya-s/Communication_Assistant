import {
  ANALYZE_STREAM_PORT,
  type AnalyzeRequest,
  type AnalyzeStreamEvent,
  type BackendResponse,
  type RuntimeMessage,
} from "../shared/messages";
import type { ConversationContext } from "../shared/types";
import type { ExtractionDiagnostics } from "../content/diagnostics";
import { isOverlayUrl, isProfileUrl } from "../platforms/urls";
import { backendFetch } from "../shared/backend";
import {
  getOrFetchProfile,
  getProfileForUrl,
  handleProfileExtracted,
  requestProfileFetch,
} from "./profileFetcher";

interface SessionState {
  lastContext: ConversationContext | null;
  lastDiagnostics: ExtractionDiagnostics | null;
  lastResponse: BackendResponse | null;
}

// Per-tab session state. Each LinkedIn/Gmail tab drafts INDEPENDENTLY, so its
// extracted context, diagnostics, and last reply are keyed by tabId. A single
// shared object would let several open threads overwrite each other — drafting
// in tab B would clobber tab A's context and the wrong thread would be answered.
// Keying by tabId is what lets you work 5 conversations at once.
const sessions = new Map<number, SessionState>();
function sessionFor(tabId: number): SessionState {
  let s = sessions.get(tabId);
  if (!s) {
    s = { lastContext: null, lastDiagnostics: null, lastResponse: null };
    sessions.set(tabId, s);
  }
  return s;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function getContentScriptFiles(): string[] {
  const m = chrome.runtime.getManifest();
  const scripts = m.content_scripts ?? [];
  const files = scripts.flatMap((cs) => cs.js ?? []);
  return files;
}

async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return resp?.type === "PONG";
  } catch {
    return false;
  }
}

async function ensureContentScriptInjected(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) throw new Error("active tab has no id");
  if (!tab.url || !isOverlayUrl(tab.url)) {
    throw new Error("active tab is not a supported messaging or profile page");
  }

  if (await pingContentScript(tab.id)) return;

  const files = getContentScriptFiles();
  if (files.length === 0) {
    throw new Error("no content_scripts declared in manifest");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files,
    });
  } catch (err) {
    throw new Error(
      `content script not loaded and auto-inject failed: ${(err as Error).message}. ` +
        "Reload the tab (Ctrl+R) and try again.",
    );
  }

  await new Promise((r) => setTimeout(r, 150));
  if (!(await pingContentScript(tab.id))) {
    throw new Error(
      "content script injected but did not respond. Reload the tab (Ctrl+R) and try again.",
    );
  }
}

interface ExtractedFromContent {
  context: ConversationContext;
  diagnostics: ExtractionDiagnostics;
}

async function requestExtractFromContent(tabId: number): Promise<ExtractedFromContent> {
  const req: RuntimeMessage = { type: "EXTRACT_REQUEST", backfill: true };
  let resp: RuntimeMessage | undefined;
  try {
    resp = await chrome.tabs.sendMessage(tabId, req);
  } catch (err) {
    throw new Error(
      `cannot reach content script: ${(err as Error).message}. ` +
        "Reload the LinkedIn tab (Ctrl+R) after loading the extension.",
    );
  }
  if (!resp || resp.type !== "CONTEXT_EXTRACTED") {
    const msg = resp && "message" in resp ? (resp as { message: string }).message : undefined;
    throw new Error(msg ?? "content script returned no context");
  }
  return { context: resp.payload, diagnostics: resp.diagnostics };
}

async function postToBackend(
  ctx: ConversationContext,
  mode: AnalyzeRequest["mode"],
  seedText: string | undefined,
  steer: string | undefined,
): Promise<BackendResponse> {
  const body = { ...ctx, mode, seed_text: seedText ?? "", steer: steer ?? "" };
  const res = await backendFetch("/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `backend ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) detail = `${detail}: ${j.error}`;
    } catch {
      // ignore body parse errors
    }
    throw new Error(detail);
  }
  return (await res.json()) as BackendResponse;
}

function needsContextExtraction(mode: AnalyzeRequest["mode"]): boolean {
  return mode !== "shorter" && mode !== "longer";
}

// --- Speculative prefetch (perf-plan Phase E) ------------------------------
//
// On thread open the content script extracts and posts CONTEXT_EXTRACTED; if the
// backend has prefetch enabled AND a fast HTTP provider is active, we pre-fire a
// `suggest` draft and stash it keyed by the exact thread state. The first Suggest
// click then serves instantly from this cache. Strongly gated: never prefetch
// onto the slow gemini-cli (we'd spend a 30s subprocess on a draft nobody asked
// for), single-use, and short-lived so a stale draft is never served.
interface PrefetchEntry {
  key: string;
  at: number;
  resp: BackendResponse;
}
const PREFETCH_TTL_MS = 2 * 60 * 1000;
// Per-tab: each tab can have its own speculative draft in flight / cached.
const prefetches = new Map<number, PrefetchEntry>();
const prefetchInFlight = new Set<number>();

// A thread's state fingerprint: title + message count + draft length. Any new
// message or draft edit changes this, so a stale prefetch can never match.
function prefetchKey(ctx: ConversationContext): string {
  const title = ctx.conversation_title ?? "";
  const msgs = ctx.messages?.length ?? 0;
  const draft = (ctx.current_draft ?? "").length;
  return `${title}|${msgs}|${draft}`;
}

interface HealthInfo {
  provider: string;
  prefetch: boolean;
}
let healthCache: { at: number; info: HealthInfo } | null = null;
async function getHealth(): Promise<HealthInfo | null> {
  if (healthCache && Date.now() - healthCache.at < 30_000) return healthCache.info;
  try {
    const res = await backendFetch("/health");
    if (!res.ok) return null;
    const j = (await res.json()) as { provider?: unknown; prefetch?: unknown };
    const info: HealthInfo = { provider: String(j.provider ?? ""), prefetch: !!j.prefetch };
    healthCache = { at: Date.now(), info };
    return info;
  } catch {
    return null;
  }
}

async function maybePrefetch(tabId: number, ctx: ConversationContext): Promise<void> {
  if (prefetchInFlight.has(tabId)) return;
  const health = await getHealth();
  // Off unless explicitly enabled, and never onto the un-primable slow CLI.
  if (!health || !health.prefetch || health.provider === "gemini-cli") return;
  const key = prefetchKey(ctx);
  const existing = prefetches.get(tabId);
  if (existing && existing.key === key && Date.now() - existing.at < PREFETCH_TTL_MS) return;
  prefetchInFlight.add(tabId);
  try {
    const resp = await postToBackend(ctx, "suggest", undefined, undefined);
    prefetches.set(tabId, { key, at: Date.now(), resp });
  } catch {
    /* best-effort: a failed prefetch just means the real click runs normally */
  } finally {
    prefetchInFlight.delete(tabId);
  }
}

// Consume this tab's prefetched draft if it matches the exact thread state and
// request. Single-use: served at most once, then discarded.
function takePrefetch(
  tabId: number,
  ctx: ConversationContext,
  mode: AnalyzeRequest["mode"],
  seed: string | undefined,
  steer: string | undefined,
): BackendResponse | null {
  if (mode !== "suggest" || seed || steer) return null; // only the plain first draft
  const entry = prefetches.get(tabId);
  if (!entry) return null;
  if (entry.key !== prefetchKey(ctx) || Date.now() - entry.at > PREFETCH_TTL_MS) {
    prefetches.delete(tabId);
    return null;
  }
  prefetches.delete(tabId);
  return entry.resp;
}

/**
 * Ask the content script on a profile page for a cold-open (first-message)
 * context: no conversation, just the contact's freshly-extracted profile.
 */
async function requestColdOpenContext(tabId: number): Promise<ConversationContext> {
  let resp: RuntimeMessage | undefined;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: "COLD_OPEN_CONTEXT_REQUEST" });
  } catch (err) {
    throw new Error(
      `cannot reach the profile page: ${(err as Error).message}. Reload the tab (Ctrl+R) and try again.`,
    );
  }
  if (resp?.type === "COLD_OPEN_CONTEXT" && resp.payload) return resp.payload;
  const msg = resp && "message" in resp ? (resp as { message: string }).message : undefined;
  throw new Error(msg ?? "couldn't read this profile to draft a first message from");
}

/**
 * Look up any cached profile for this contact and attach it to the context
 * before posting to the backend. We don't block on a fetch — if there's
 * nothing cached yet, the request goes out without enrichment and the next
 * one will benefit (the fetch was kicked off when the thread first opened).
 */
async function attachContactProfile(ctx: ConversationContext): Promise<ConversationContext> {
  const url = ctx.contact_profile_url;
  if (!url) return ctx;
  const profile = await getProfileForUrl(url);
  if (!profile) return ctx;
  return { ...ctx, contact_profile: profile };
}

/**
 * Build the ConversationContext for an analyze request: cold-open pulls the
 * profile-only context; other modes extract (or reuse) the open thread and
 * attach any cached contact profile. Shared by the JSON and streaming paths.
 */
async function resolveAnalyzeContext(
  req: AnalyzeRequest,
  tab: chrome.tabs.Tab,
): Promise<ConversationContext> {
  const session = sessionFor(tab.id!);
  if (req.mode === "cold_open") {
    await ensureContentScriptInjected(tab);
    const ctx = await requestColdOpenContext(tab.id!);
    session.lastContext = ctx;
    return ctx;
  }
  let ctx: ConversationContext;
  if (needsContextExtraction(req.mode)) {
    await ensureContentScriptInjected(tab);
    const extracted = await requestExtractFromContent(tab.id!);
    ctx = extracted.context;
    session.lastContext = ctx;
    session.lastDiagnostics = extracted.diagnostics;
  } else if (session.lastContext) {
    // shorter/longer reuse THIS tab's last context (not some other tab's).
    ctx = session.lastContext;
  } else {
    await ensureContentScriptInjected(tab);
    const extracted = await requestExtractFromContent(tab.id!);
    ctx = extracted.context;
    session.lastContext = ctx;
    session.lastDiagnostics = extracted.diagnostics;
  }
  return attachContactProfile(ctx);
}

async function handleAnalyze(
  req: AnalyzeRequest,
  tab: chrome.tabs.Tab | null,
): Promise<RuntimeMessage> {
  if (!tab || tab.id === undefined) return { type: "ERROR", message: "no active tab" };

  try {
    const ctx = await resolveAnalyzeContext(req, tab);
    const resp = await postToBackend(ctx, req.mode, req.seed_text, req.steer);
    sessionFor(tab.id).lastResponse = resp;
    return { type: "BACKEND_RESPONSE", payload: resp };
  } catch (err) {
    return { type: "ERROR", message: (err as Error).message };
  }
}

/** Parse one SSE event block ("event: <name>\ndata: <json>"). */
function parseSseEvent(raw: string): { event: string; data: Record<string, unknown> } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Run an analyze and relay it to the overlay over a Port: SSE tokens when the
 * provider streams, or a single final batch when it doesn't (gemini-cli returns
 * JSON). The overlay consumes the same event sequence either way.
 */
async function streamAnalyzeToPort(req: AnalyzeRequest, port: chrome.runtime.Port): Promise<void> {
  const send = (e: AnalyzeStreamEvent) => {
    try {
      port.postMessage(e);
    } catch {
      /* port disconnected — overlay closed; stop relaying */
    }
  };

  // Use the tab that OPENED this Port (the overlay's own tab), not the active
  // tab — so a draft started in a background tab answers that tab's thread, and
  // five tabs streaming at once never cross-wire. Falls back to the active tab
  // only if the sender is somehow missing.
  const tab = port.sender?.tab ?? (await getActiveTab());
  if (!tab || tab.id === undefined) {
    send({ type: "error", message: "no originating tab" });
    return;
  }
  const tabId = tab.id;
  const session = sessionFor(tabId);

  let ctx: ConversationContext;
  try {
    ctx = await resolveAnalyzeContext(req, tab);
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
    return;
  }

  // Instant path: a speculative prefetch already drafted this exact thread state.
  const cached = takePrefetch(tabId, ctx, req.mode, req.seed_text, req.steer);
  if (cached) {
    session.lastResponse = cached;
    send({ type: "reply_done", suggested_reply: cached.suggested_reply, stats: cached.stats });
    send({ type: "insight", memory_proposal: cached.memory_proposal, strategy: cached.strategy });
    send({ type: "done" });
    return;
  }

  const body = { ...ctx, mode: req.mode, seed_text: req.seed_text ?? "", steer: req.steer ?? "", stream: true };
  let res: Response;
  try {
    res = await backendFetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
    return;
  }
  if (!res.ok) {
    let detail = `backend ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) detail = `${detail}: ${j.error}`;
    } catch {
      /* ignore body parse errors */
    }
    send({ type: "error", message: detail });
    return;
  }

  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    // Provider can't stream (gemini-cli) — backend returned JSON. Emit a single
    // final batch so the overlay's streaming consumer still works unchanged.
    try {
      const j = (await res.json()) as BackendResponse;
      session.lastResponse = j;
      send({ type: "reply_done", suggested_reply: j.suggested_reply, stats: j.stats });
      send({ type: "insight", memory_proposal: j.memory_proposal, strategy: j.strategy });
      send({ type: "done" });
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    }
    return;
  }

  // Parse the SSE stream, buffering across chunks (events can split mid-line).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastReply = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const evt = parseSseEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (!evt) continue;
        if (evt.event === "token") {
          send({ type: "token", t: (evt.data.t as string) ?? "" });
        } else if (evt.event === "reply_done") {
          lastReply = (evt.data.suggested_reply as string) ?? "";
          send({ type: "reply_done", suggested_reply: lastReply, stats: evt.data.stats as Record<string, unknown> });
        } else if (evt.event === "insight") {
          send({
            type: "insight",
            memory_proposal: (evt.data.memory_proposal as BackendResponse["memory_proposal"]) ?? null,
            strategy: (evt.data.strategy as BackendResponse["strategy"]) ?? null,
          });
        } else if (evt.event === "error") {
          send({ type: "error", message: (evt.data.error as string) ?? "stream error" });
        } else if (evt.event === "done") {
          send({ type: "done" });
        }
      }
    }
    if (lastReply) {
      session.lastResponse = { suggested_reply: lastReply, memory_proposal: null, strategy: null };
    }
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
  }
}

/**
 * Manual "open the panel" from the popup: ensure the content script is present
 * on the active tab (it may predate the extension, or the tab was restored from
 * a session) and tell it to (re-)mount the overlay.
 */
async function handleOpenOverlay(): Promise<RuntimeMessage> {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) return { type: "ERROR", message: "no active tab" };
  try {
    await ensureContentScriptInjected(tab); // throws on unsupported pages
    const resp = (await chrome.tabs.sendMessage(tab.id, { type: "SHOW_OVERLAY" })) as
      | RuntimeMessage
      | undefined;
    return resp ?? { type: "OVERLAY_OPENED" };
  } catch (err) {
    return { type: "ERROR", message: (err as Error).message };
  }
}

/**
 * Compose a first message from the popup, given just a profile URL + intent.
 * Fetches the profile out-of-band (hidden tab), then runs a cold_open analyze.
 * Works from any page — no thread, no active LinkedIn tab required.
 */
async function handleComposeIntro(req: {
  profileUrl: string;
  intent: string;
}): Promise<RuntimeMessage> {
  const url = (req.profileUrl || "").trim();
  if (!isProfileUrl(url)) {
    return { type: "ERROR", message: "enter a LinkedIn profile URL (linkedin.com/in/…)" };
  }
  let profile;
  try {
    profile = await getOrFetchProfile(url);
  } catch (err) {
    return { type: "ERROR", message: `profile fetch failed: ${(err as Error).message}` };
  }
  if (!profile || !profile.name) {
    return { type: "ERROR", message: "couldn't read that profile — open it in a tab once, then retry" };
  }

  const ctx: ConversationContext = {
    platform: "linkedin",
    conversation_title: profile.name,
    participants: [{ name: profile.name }],
    messages: [],
    current_draft: "",
    page_metadata: { url, title: profile.name, extracted_at: new Date().toISOString() },
    contact_profile_url: profile.profileUrl || url,
    contact_profile: profile,
  };

  try {
    // Popup-initiated and out-of-band (no LinkedIn tab) — the popup renders the
    // result itself, so there's no tab session to persist into.
    const resp = await postToBackend(ctx, "cold_open", "", req.intent ?? "");
    return { type: "BACKEND_RESPONSE", payload: resp };
  } catch (err) {
    return { type: "ERROR", message: (err as Error).message };
  }
}

/**
 * Cold-start: import the USER'S OWN LinkedIn profile (the active profile tab)
 * into the backend's personal-context store. Reuses the cold-open profile
 * extractor — no new content-script code — then POSTs the scraped
 * ContactProfile to `/onboarding/from-linkedin`, which creates *proposed*
 * "About me" context items for the user to confirm in the dashboard.
 */
async function handleImportSelfProfile(): Promise<RuntimeMessage> {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) return { type: "ERROR", message: "no active tab" };
  if (!tab.url || !isProfileUrl(tab.url)) {
    return { type: "ERROR", message: "open your own LinkedIn profile first" };
  }

  try {
    await ensureContentScriptInjected(tab);
    const ctx = await requestColdOpenContext(tab.id);
    const profile = ctx.contact_profile;
    if (!profile || !profile.name) {
      return { type: "ERROR", message: "couldn't read this profile" };
    }

    const res = await backendFetch("/onboarding/from-linkedin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    if (!res.ok) {
      let detail = `backend ${res.status}`;
      try {
        const j = await res.json();
        if (j?.error) detail = `${detail}: ${j.error}`;
      } catch {
        // ignore body parse errors
      }
      return { type: "ERROR", message: detail };
    }
    const j = (await res.json()) as { ok?: boolean; created?: number };
    return { type: "IMPORT_RESULT", payload: { created: j.created ?? 0 } };
  } catch (err) {
    return { type: "ERROR", message: (err as Error).message };
  }
}

// Streaming analyze over a long-lived Port (token-by-token to the overlay).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ANALYZE_STREAM_PORT) return;
  port.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === "ANALYZE_REQUEST") {
      void streamAnalyzeToPort(msg as AnalyzeRequest, port);
    }
  });
});

// Free a tab's session + any pending prefetch when it closes, so state doesn't
// accumulate as you open and close conversations.
chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  prefetches.delete(tabId);
  prefetchInFlight.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  if (msg.type === "ANALYZE_REQUEST") {
    // Prefer the tab the request came FROM (the overlay's own tab); fall back to
    // the active tab for callers without a tab (e.g. popup).
    const fromTab = sender.tab ?? null;
    (fromTab ? Promise.resolve(fromTab) : getActiveTab()).then((tab) =>
      handleAnalyze(msg, tab).then(sendResponse),
    );
    return true;
  }

  if (msg.type === "OPEN_OVERLAY") {
    handleOpenOverlay().then(sendResponse);
    return true;
  }

  if (msg.type === "COMPOSE_INTRO") {
    handleComposeIntro(msg).then(sendResponse);
    return true;
  }

  if (msg.type === "IMPORT_SELF_PROFILE") {
    handleImportSelfProfile().then(sendResponse);
    return true;
  }

  if (msg.type === "STATUS_REQUEST") {
    // Report the requesting tab's own session (each overlay sees only its thread).
    const reply = (tabId: number | undefined) => {
      const s = tabId !== undefined ? sessions.get(tabId) : undefined;
      sendResponse({
        type: "STATUS_RESPONSE",
        lastContext: s?.lastContext ?? null,
        lastDiagnostics: s?.lastDiagnostics ?? null,
        lastResponse: s?.lastResponse ?? null,
      });
    };
    if (sender.tab?.id !== undefined) {
      reply(sender.tab.id);
      return false;
    }
    getActiveTab().then((t) => reply(t?.id ?? undefined));
    return true; // async: resolving the active tab for a tab-less caller
  }

  if (msg.type === "CONTEXT_EXTRACTED") {
    // Store against the tab that extracted it, and prefetch for that tab only.
    if (msg.trigger === "observer" && sender.tab?.id !== undefined) {
      const tabId = sender.tab.id;
      const s = sessionFor(tabId);
      s.lastContext = msg.payload;
      s.lastDiagnostics = msg.diagnostics;
      // Thread opened/changed — speculatively draft a Suggest so the first click
      // is instant (no-op unless the backend has prefetch on + a fast provider).
      void maybePrefetch(tabId, msg.payload);
    }
    return false;
  }

  if (msg.type === "PROFILE_FETCH_REQUEST") {
    void requestProfileFetch(msg.profileUrl);
    return false;
  }

  if (msg.type === "PROFILE_EXTRACTED") {
    void handleProfileExtracted(msg.payload, sender.tab?.id);
    return false;
  }

  return false;
});
