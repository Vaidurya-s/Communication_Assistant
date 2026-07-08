import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractLinkedInContext } from "./linkedin";
import { hasLayoutAnomaly } from "./diagnostics";

// extractLinkedInContext reads getSelfNameSetting() → chrome.storage.sync. Stub it.
beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { sync: { get: vi.fn().mockResolvedValue({}) } },
  };
  // Put us on a thread route so the render-race wait engages.
  window.history.pushState({}, "", "/messaging/thread/2-abc==/");
});

afterEach(() => {
  document.body.innerHTML = "";
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

function threadHtml(): string {
  return `
    <div class="msg-s-message-list-container">
      <ul class="msg-s-message-list">
        <li class="msg-s-message-list__event">
          <div class="msg-s-message-group__meta">
            <span class="msg-s-message-group__name">Dr. Bidrohi Bhattacharjee</span>
          </div>
          <div class="msg-s-event-listitem">
            <div class="msg-s-event-listitem__body">Happy to collaborate on the research.</div>
          </div>
        </li>
      </ul>
    </div>`;
}

describe("linkedin extraction render-race", () => {
  it("waits for a thread that paints AFTER extraction starts (the My-Network race)", async () => {
    // Start with the WRONG page mounted (no messaging container) — mimics the
    // SPA still showing the previous surface mid-navigation.
    document.body.innerHTML = `<main id="workspace"><div>My Network feed</div></main>`;

    const extracting = extractLinkedInContext();
    // Thread paints ~250ms later, well within the wait budget.
    setTimeout(() => {
      document.body.innerHTML = threadHtml();
    }, 250);

    const { context, diagnostics } = await extracting;
    expect(context.messages.length).toBe(1);
    expect(context.messages[0].text).toContain("Happy to collaborate");
    expect(diagnostics.anomalies).not.toContain("zero-messages-on-thread-route");
    expect(diagnostics.selectorHits.messageListContainer).toBe(".msg-s-message-list-container");
  });

  it("reads a thread that is already painted immediately", async () => {
    document.body.innerHTML = threadHtml();
    const { context } = await extractLinkedInContext();
    expect(context.messages.length).toBe(1);
    expect(context.messages[0].sender).toBe("Dr. Bidrohi Bhattacharjee");
  });

  it("reports 'not mounted' (not a layout break) when the wrong surface is up", async () => {
    // URL is a thread, but the document is the feed / My Network shell — zero
    // `msg-*`-classed elements, so the messaging app plainly isn't mounted. This
    // is the real captured failure: the SPA kept the wrong surface under a thread
    // URL. Extraction must NOT claim the layout changed.
    document.body.innerHTML = `<main id="workspace"><div class="feed-shared">No pending invitations</div></main>`;

    const started = Date.now();
    const { context, diagnostics } = await extractLinkedInContext();
    const elapsedMs = Date.now() - started;

    expect(context.messages.length).toBe(0);
    expect(diagnostics.anomalies).toContain("messaging-thread-not-mounted");
    // The honest state replaces the misleading selector-break anomalies…
    expect(diagnostics.anomalies).not.toContain("message-list-container-missing");
    expect(diagnostics.anomalies).not.toContain("zero-messages-on-thread-route");
    // …and it isn't classified as a layout break (overlay shows guidance, not
    // "save a snapshot to fix").
    expect(hasLayoutAnomaly(diagnostics.anomalies)).toBe(false);
    // Fast-bail: ~3s grace, not the full 10s budget. (Generous upper bound.)
    expect(elapsedMs).toBeLessThan(8000);
  });
});
