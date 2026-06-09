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

let observer: MutationObserver | null = null;
let installRetryHandle: number | null = null;

// Last extraction is held in module scope so the snapshot mechanism (Phase 1b)
// can grab the most recent diagnostics + parsed result without re-running.
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
  // Auto-arm a forensic snapshot whenever an anomaly is detected. Overwrites
  // any previously-armed one so the freshest broken state wins.
  if (result.diagnostics.anomalies.length > 0) armAnomalySnapshot();
  return result;
}

async function sendExtracted(trigger: "user" | "observer"): Promise<void> {
  try {
    // Observer-driven extractions never backfill (cheap path).
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
}

// Background pings this listener to confirm the content script is alive
// before attempting an extract. Liveness checks must respond synchronously.
chrome.runtime.onMessage.addListener(
  (msg: { type?: string } & Record<string, unknown>, _sender, sendResponse) => {
    if (msg?.type === "PING") {
      sendResponse({ type: "PONG" });
      return false;
    }

    if (msg?.type !== "EXTRACT_REQUEST") return;

    (async () => {
      try {
        const backfill = !!(msg as RuntimeMessage & { backfill: boolean }).backfill;
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

    return true; // async response
  },
);

bootForCurrentRoute();

// LinkedIn is a SPA. Hook history methods + popstate to detect URL changes
// without observing the whole document.
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
