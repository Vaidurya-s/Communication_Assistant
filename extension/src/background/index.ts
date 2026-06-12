import {
  type AnalyzeRequest,
  type BackendResponse,
  type RuntimeMessage,
} from "../shared/messages";
import type { ConversationContext } from "../shared/types";
import type { ExtractionDiagnostics } from "../content/diagnostics";
import { isSupportedMessagingUrl } from "../platforms/urls";
import { backendFetch } from "../shared/backend";
import {
  getProfileForUrl,
  handleProfileExtracted,
  requestProfileFetch,
} from "./profileFetcher";

interface SessionState {
  lastContext: ConversationContext | null;
  lastDiagnostics: ExtractionDiagnostics | null;
  lastResponse: BackendResponse | null;
}

const state: SessionState = {
  lastContext: null,
  lastDiagnostics: null,
  lastResponse: null,
};

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
  if (!tab.url || !isSupportedMessagingUrl(tab.url)) {
    throw new Error("active tab is not a supported messaging page");
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

async function handleAnalyze(req: AnalyzeRequest): Promise<RuntimeMessage> {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) return { type: "ERROR", message: "no active tab" };

  try {
    let ctx: ConversationContext;
    if (needsContextExtraction(req.mode)) {
      await ensureContentScriptInjected(tab);
      const extracted = await requestExtractFromContent(tab.id);
      ctx = extracted.context;
      state.lastContext = ctx;
      state.lastDiagnostics = extracted.diagnostics;
    } else if (state.lastContext) {
      ctx = state.lastContext;
    } else {
      await ensureContentScriptInjected(tab);
      const extracted = await requestExtractFromContent(tab.id);
      ctx = extracted.context;
      state.lastContext = ctx;
      state.lastDiagnostics = extracted.diagnostics;
    }
    ctx = await attachContactProfile(ctx);
    const resp = await postToBackend(ctx, req.mode, req.seed_text, req.steer);
    state.lastResponse = resp;
    return { type: "BACKEND_RESPONSE", payload: resp };
  } catch (err) {
    return { type: "ERROR", message: (err as Error).message };
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

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  if (msg.type === "ANALYZE_REQUEST") {
    handleAnalyze(msg).then(sendResponse);
    return true;
  }

  if (msg.type === "OPEN_OVERLAY") {
    handleOpenOverlay().then(sendResponse);
    return true;
  }

  if (msg.type === "STATUS_REQUEST") {
    const resp: RuntimeMessage = {
      type: "STATUS_RESPONSE",
      lastContext: state.lastContext,
      lastDiagnostics: state.lastDiagnostics,
      lastResponse: state.lastResponse,
    };
    sendResponse(resp);
    return false;
  }

  if (msg.type === "CONTEXT_EXTRACTED") {
    if (msg.trigger === "observer") {
      state.lastContext = msg.payload;
      state.lastDiagnostics = msg.diagnostics;
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
