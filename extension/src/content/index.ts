import type { RuntimeMessage } from "../shared/messages";
import type { ConversationContext, ExtractionResult } from "../shared/types";
import type { ContactProfile } from "../shared/profile";
import { messagingExtractor, profileExtractor } from "../platforms/registry";
import { ENRICHMENT_HASH } from "../platforms/urls";
import { getCurrentExtractor, setCurrentExtractor } from "./currentPlatform";
import { mountOverlay, unmountOverlay } from "../overlay/mount";
import { armAnomalySnapshot, clearArmedSnapshot } from "./snapshot";
import type { PlatformExtractor } from "../platforms/types";

let observer: MutationObserver | null = null;
let installRetryHandle: number | null = null;

let lastExtraction: ExtractionResult | null = null;

export function getLastExtraction(): ExtractionResult | null {
  return lastExtraction;
}

async function extractAndRemember(backfill: boolean): Promise<ExtractionResult> {
  const ext = getCurrentExtractor();
  if (!ext) throw new Error("no platform extractor for this page");
  let backfillMs = -1;
  if (backfill) backfillMs = await ext.backfillMessages();
  const result = await ext.extractContext();
  if (backfillMs >= 0) result.diagnostics.backfillMs = backfillMs;
  lastExtraction = result;
  // Arm a snapshot when something looks off; clear any prior warning when the
  // extraction comes back clean (the observer re-extracts as the page settles,
  // so a transient miss self-heals instead of lingering).
  if (result.diagnostics.anomalies.length > 0) armAnomalySnapshot();
  else clearArmedSnapshot();
  return result;
}

async function sendExtracted(trigger: "user" | "observer"): Promise<void> {
  try {
    const result = await extractAndRemember(false);
    const msg: RuntimeMessage = {
      type: "CONTEXT_EXTRACTED",
      payload: result.context,
      diagnostics: result.diagnostics,
      trigger,
      anomalySnapshotArmed: result.diagnostics.anomalies.length > 0,
    };
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (err) {
    const errMsg: RuntimeMessage = {
      type: "ERROR",
      message: `extract failed: ${(err as Error).message}`,
    };
    chrome.runtime.sendMessage(errMsg).catch(() => {});
  }
}

function tryInstallObserver(): void {
  if (observer) return;
  // Were we retrying because the list wasn't there yet? If so, this successful
  // install means the thread painted LATE (the extraction-render-race case).
  const installedLate = installRetryHandle !== null;
  observer = getCurrentExtractor()?.installMessageObserver(() => {
    void sendExtracted("observer");
  }) ?? null;
  if (!observer) {
    if (installRetryHandle !== null) window.clearTimeout(installRetryHandle);
    installRetryHandle = window.setTimeout(tryInstallObserver, 1000);
    return;
  }
  if (installRetryHandle !== null) {
    window.clearTimeout(installRetryHandle);
    installRetryHandle = null;
  }
  // A thread that finishes painting AFTER we install the observer fires no
  // further mutations, so the observer alone would never re-extract it. Kick
  // one extraction on a late install so lastContext / prefetch reflect the
  // now-rendered thread instead of the stale pre-navigation page.
  if (installedLate) void sendExtracted("observer");
}

/**
 * On thread open: discover the contact's profile URL and ask the background
 * to fetch the profile (out-of-band, hidden tab). Background caches and
 * dedupes. Safe to call repeatedly — background no-ops if cache is fresh.
 */
function maybeKickProfileFetch(): void {
  // Defer one tick — the thread header sometimes hydrates a beat after route change.
  window.setTimeout(() => {
    const url = getCurrentExtractor()?.getContactProfileUrl();
    if (!url) return;
    const msg: RuntimeMessage = { type: "PROFILE_FETCH_REQUEST", profileUrl: url };
    chrome.runtime.sendMessage(msg).catch(() => {});
  }, 1500);
}

/**
 * Build a synthetic conversation context for a FIRST message — no history. The
 * contact's profile is the only grounding; the backend drafts a cold-open from
 * it plus the user's intent (sent as `steer`). title = the contact's name so
 * the contact gets remembered under the same key a later thread would use.
 */
function buildColdOpenContext(profile: ContactProfile): ConversationContext {
  const ext = getCurrentExtractor();
  return {
    platform: ext?.platform ?? "linkedin",
    conversation_title: profile.name,
    participants: profile.name ? [{ name: profile.name }] : [],
    messages: [],
    current_draft: "",
    page_metadata: {
      url: window.location.href,
      title: document.title,
      extracted_at: new Date().toISOString(),
    },
    contact_profile_url: profile.profileUrl || window.location.href,
    contact_profile: profile,
  };
}

/** Read the profile this page is showing and return a cold-open context, or null. */
async function readColdOpenContext(prof: PlatformExtractor): Promise<ConversationContext | null> {
  await prof.waitForProfileReady(8000);
  const profile = prof.extractProfile();
  if (!profile.name) return null;
  setCurrentExtractor(prof);
  return buildColdOpenContext(profile);
}

/**
 * Profile-page overlay: when the user is viewing a contact's profile, mount the
 * overlay in its cold-open variant so they can draft a first message. Works in
 * background tabs too (no visibility gate) — only the enrichment fetcher's
 * hash-marked throwaway tabs are excluded, by the caller below.
 */
async function mountColdOpenOverlay(prof: PlatformExtractor): Promise<void> {
  try {
    const ctx = await readColdOpenContext(prof);
    if (!ctx) {
      unmountOverlay();
      return;
    }
    mountOverlay({ coldOpen: { contactName: ctx.conversation_title } });
  } catch {
    unmountOverlay();
  }
}

function bootForCurrentRoute(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (installRetryHandle !== null) {
    window.clearTimeout(installRetryHandle);
    installRetryHandle = null;
  }
  const ext = messagingExtractor(window.location);
  if (ext) {
    setCurrentExtractor(ext);
    tryInstallObserver();
    mountOverlay();
    maybeKickProfileFetch();
    return;
  }
  // Not a messaging surface. If it's a profile page the user is looking at,
  // offer a cold-open first-message draft instead. Skip the enrichment fetcher's
  // hash-marked tabs — those are opened hidden only to scrape the profile.
  const prof = profileExtractor(window.location);
  if (prof && window.location.hash !== ENRICHMENT_HASH) {
    void mountColdOpenOverlay(prof);
    return;
  }
  setCurrentExtractor(null);
  unmountOverlay();
}

chrome.runtime.onMessage.addListener(
  (msg: { type?: string } & Record<string, unknown>, _sender, sendResponse) => {
    if (msg?.type === "PING") {
      sendResponse({ type: "PONG" });
      return false;
    }

    if (msg?.type === "SHOW_OVERLAY") {
      // Re-evaluate the route and mount. Handles a panel closed with ×, a tab
      // that loaded before the extension, or a restored session where the
      // initial boot missed. Works on both messaging surfaces and profile
      // pages (the latter mounts the cold-open variant).
      bootForCurrentRoute();
      const onRoute =
        !!messagingExtractor(window.location) || !!profileExtractor(window.location);
      sendResponse(
        onRoute
          ? { type: "OVERLAY_OPENED" }
          : { type: "ERROR", message: "open a LinkedIn/Gmail thread or a LinkedIn profile" },
      );
      return false;
    }

    if (msg?.type === "COLD_OPEN_CONTEXT_REQUEST") {
      (async () => {
        const prof = profileExtractor(window.location);
        if (!prof) {
          sendResponse({ type: "COLD_OPEN_CONTEXT", payload: null });
          return;
        }
        try {
          const ctx = await readColdOpenContext(prof);
          sendResponse({ type: "COLD_OPEN_CONTEXT", payload: ctx });
        } catch (err) {
          sendResponse({ type: "ERROR", message: (err as Error).message });
        }
      })();
      return true; // async response
    }

    if (msg?.type !== "EXTRACT_REQUEST") return;

    (async () => {
      try {
        const backfill = !!(msg as { backfill?: boolean }).backfill;
        const result = await extractAndRemember(backfill);
        sendResponse({
          type: "CONTEXT_EXTRACTED",
          payload: result.context,
          diagnostics: result.diagnostics,
          trigger: "user",
          anomalySnapshotArmed: result.diagnostics.anomalies.length > 0,
        });
      } catch (err) {
        sendResponse({ type: "ERROR", message: (err as Error).message });
      }
    })();

    return true;
  },
);

/**
 * Profile-page bootstrap: if this content script instance was loaded onto a
 * /in/<handle>/ page, extract the profile and send it back. This is the
 * receiving end of background-initiated hidden-tab fetches.
 */
async function bootForProfilePage(): Promise<void> {
  const ext = profileExtractor(window.location);
  if (!ext) return;
  await ext.waitForProfileReady(8000);
  try {
    const profile = ext.extractProfile();
    if (!profile.name) return;
    const msg: RuntimeMessage = { type: "PROFILE_EXTRACTED", payload: profile };
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (err) {
    chrome.runtime
      .sendMessage({
        type: "ERROR",
        message: `profile extract failed: ${(err as Error).message}`,
      } satisfies RuntimeMessage)
      .catch(() => {});
  }
}

bootForCurrentRoute();
void bootForProfilePage();

const onUrlChange = () => bootForCurrentRoute();

const origPushState = history.pushState;
history.pushState = function (...args: Parameters<typeof history.pushState>) {
  const ret = origPushState.apply(this, args);
  window.dispatchEvent(new Event("__commsasst_locationchange"));
  return ret;
};
const origReplaceState = history.replaceState;
history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
  const ret = origReplaceState.apply(this, args);
  window.dispatchEvent(new Event("__commsasst_locationchange"));
  return ret;
};
window.addEventListener("popstate", onUrlChange);
window.addEventListener("__commsasst_locationchange", onUrlChange);
// Gmail navigates via the URL hash (#inbox/<id>), which fires `hashchange`
// rather than popstate/pushState — re-evaluate the route on it too.
window.addEventListener("hashchange", onUrlChange);
