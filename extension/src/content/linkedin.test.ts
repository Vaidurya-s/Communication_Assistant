import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractLinkedInContext } from "./linkedin";

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
});
