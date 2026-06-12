import type { RuntimeMessage } from "../shared/messages";
import type { ExtractionResult } from "../shared/types";
import { messagingExtractor, profileExtractor } from "../platforms/registry";
import { getCurrentExtractor, setCurrentExtractor } from "./currentPlatform";
import { mountOverlay, unmountOverlay } from "../overlay/mount";
import { armAnomalySnapshot, clearArmedSnapshot } from "./snapshot";

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
  observer = getCurrentExtractor()?.installMessageObserver(() => {
    void sendExtracted("observer");
  }) ?? null;
  if (!observer) {
    if (installRetryHandle !== null) window.clearTimeout(installRetryHandle);
    installRetryHandle = window.setTimeout(tryInstallObserver, 1000);
  }
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
  if (!ext) {
    setCurrentExtractor(null);
    unmountOverlay();
    return;
  }
  setCurrentExtractor(ext);
  tryInstallObserver();
  mountOverlay();
  maybeKickProfileFetch();
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
      // initial boot missed.
      bootForCurrentRoute();
      const onRoute = !!messagingExtractor(window.location);
      sendResponse(
        onRoute
          ? { type: "OVERLAY_OPENED" }
          : { type: "ERROR", message: "not a supported messaging page" },
      );
      return false;
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
