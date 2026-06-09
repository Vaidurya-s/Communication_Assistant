import type { RuntimeMessage } from "../shared/messages";
import type { ExtractionResult } from "../shared/types";
import { isLinkedInMessagingRoute } from "./detector";
import {
  backfillMessages,
  extractLinkedInContext,
  installMessageObserver,
} from "./linkedin";
import { mountOverlay, unmountOverlay } from "../overlay/mount";
import { armAnomalySnapshot } from "./snapshot";
import {
  extractLinkedInProfile,
  getThreadContactProfileUrl,
  isOnProfilePage,
  waitForProfileReady,
} from "./profile";

let observer: MutationObserver | null = null;
let installRetryHandle: number | null = null;

let lastExtraction: ExtractionResult | null = null;

export function getLastExtraction(): ExtractionResult | null {
  return lastExtraction;
}

async function extractAndRemember(backfill: boolean): Promise<ExtractionResult> {
  let backfillMs = -1;
  if (backfill) backfillMs = await backfillMessages();
  const result = await extractLinkedInContext();
  if (backfillMs >= 0) result.diagnostics.backfillMs = backfillMs;
  lastExtraction = result;
  if (result.diagnostics.anomalies.length > 0) armAnomalySnapshot();
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
  observer = installMessageObserver(() => {
    void sendExtracted("observer");
  });
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
    const url = getThreadContactProfileUrl();
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
  if (!isLinkedInMessagingRoute(window.location)) {
    unmountOverlay();
    return;
  }
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
  if (!isOnProfilePage()) return;
  await waitForProfileReady(8000);
  try {
    const profile = extractLinkedInProfile();
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
