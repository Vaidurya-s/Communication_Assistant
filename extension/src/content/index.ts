import type { RuntimeMessage } from "../shared/messages";
import { isLinkedInMessagingRoute } from "./detector";
import {
  backfillMessages,
  extractLinkedInContext,
  installMessageObserver,
} from "./linkedin";
import { mountOverlay, unmountOverlay } from "../overlay/mount";

let observer: MutationObserver | null = null;
let installRetryHandle: number | null = null;

async function sendExtracted(trigger: "user" | "observer"): Promise<void> {
  try {
    const ctx = await extractLinkedInContext();
    const msg: RuntimeMessage = { type: "CONTEXT_EXTRACTED", payload: ctx, trigger };
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
    // LinkedIn lazy-mounts the messaging pane; retry until it appears.
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
        if ((msg as RuntimeMessage & { backfill: boolean }).backfill) await backfillMessages();
        const ctx = await extractLinkedInContext();
        sendResponse({ type: "CONTEXT_EXTRACTED", payload: ctx, trigger: "user" });
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
