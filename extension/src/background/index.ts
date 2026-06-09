import {
  BACKEND_URL,
  type AnalyzeRequest,
  type BackendResponse,
  type RuntimeMessage,
} from "../shared/messages";
import type { ConversationContext } from "../shared/types";

interface SessionState {
  lastContext: ConversationContext | null;
  lastResponse: BackendResponse | null;
}

const state: SessionState = {
  lastContext: null,
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
  if (!tab.url || !tab.url.includes("linkedin.com")) {
    throw new Error("active tab is not LinkedIn");
  }

  if (await pingContentScript(tab.id)) return;

  // Tab was likely open before the extension was loaded — content scripts
  // don't retroactively inject. Inject programmatically now. Path comes from
  // the runtime manifest so we don't hard-code crxjs's hashed filename.
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
        "Reload the LinkedIn tab (Ctrl+R) and try again.",
    );
  }

  await new Promise((r) => setTimeout(r, 150));
  if (!(await pingContentScript(tab.id))) {
    throw new Error(
      "content script injected but did not respond. Reload the LinkedIn tab (Ctrl+R) and try again.",
    );
  }
}

async function requestExtractFromContent(tabId: number): Promise<ConversationContext> {
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
  return resp.payload as ConversationContext;
}

async function postToBackend(
  ctx: ConversationContext,
  mode: AnalyzeRequest["mode"],
  seedText: string | undefined,
): Promise<BackendResponse> {
  const body = { ...ctx, mode, seed_text: seedText ?? "" };
  const res = await fetch(BACKEND_URL, {
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

// `shorter`/`longer` can run without re-extracting the conversation — they only
// need the seed_text. Skipping extraction saves the 5-10s scroll-backfill.
function needsContextExtraction(mode: AnalyzeRequest["mode"]): boolean {
  return mode !== "shorter" && mode !== "longer";
}

async function handleAnalyze(req: AnalyzeRequest): Promise<RuntimeMessage> {
  const tab = await getActiveTab();
  if (!tab || tab.id === undefined) return { type: "ERROR", message: "no active tab" };

  try {
    let ctx: ConversationContext;
    if (needsContextExtraction(req.mode)) {
      await ensureContentScriptInjected(tab);
      ctx = await requestExtractFromContent(tab.id);
      state.lastContext = ctx;
    } else {
      // Reuse the last extracted context if we have it; otherwise extract.
      if (state.lastContext) {
        ctx = state.lastContext;
      } else {
        await ensureContentScriptInjected(tab);
        ctx = await requestExtractFromContent(tab.id);
        state.lastContext = ctx;
      }
    }
    const resp = await postToBackend(ctx, req.mode, req.seed_text);
    state.lastResponse = resp;
    return { type: "BACKEND_RESPONSE", payload: resp };
  } catch (err) {
    return { type: "ERROR", message: (err as Error).message };
  }
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === "ANALYZE_REQUEST") {
    handleAnalyze(msg).then(sendResponse);
    return true;
  }

  if (msg.type === "STATUS_REQUEST") {
    const resp: RuntimeMessage = {
      type: "STATUS_RESPONSE",
      lastContext: state.lastContext,
      lastResponse: state.lastResponse,
    };
    sendResponse(resp);
    return false;
  }

  if (msg.type === "CONTEXT_EXTRACTED") {
    // Observer-driven update: cache it locally so the popup can show a fresh
    // preview without re-triggering extraction. Do NOT hit the backend here.
    if (msg.trigger === "observer") {
      state.lastContext = msg.payload;
    }
    return false;
  }

  return false;
});
