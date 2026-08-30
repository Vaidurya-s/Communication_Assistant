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

/**
 * Thread built from a real saved snapshot (2026-08-30): a single inbound
 * message, the contact's name carrying LinkedIn's "Verified" badge SVG beside
 * it, and no reply from the user yet.
 */
function unansweredThreadHtml(senderName = "Vinay Singhwal"): string {
  return `
    <div class="msg-entity-lockup__entity-title">Vinay Singhwal</div>
    <div class="msg-s-message-list-container">
      <ul class="msg-s-message-list">
        <li class="msg-s-message-list__event">
          <div class="msg-s-message-group__meta">
            <span class="msg-s-message-group__name">${senderName}</span>
            <svg role="img" aria-label="LinkedIn Verified" class="msg-ui-profile__badge-icon"></svg>
          </div>
          <div class="msg-s-event-listitem">
            <div class="msg-s-event-listitem__body">Hi vaidurya, good to see someone from EE.</div>
          </div>
        </li>
      </ul>
    </div>`;
}

describe("self-name anomaly", () => {
  function withSelfName(name: string) {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { sync: { get: vi.fn().mockResolvedValue({ selfName: name }) } },
    };
  }

  it("does NOT warn on a thread the user hasn't replied to yet", async () => {
    // The reported false positive. Every message is legitimately the contact's,
    // and this is exactly the thread you most want to draft in — warning here
    // trains the user to ignore the banner.
    withSelfName("Vaidurya Shah");
    document.body.innerHTML = unansweredThreadHtml();
    const { diagnostics, context } = await extractLinkedInContext();
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].isSelf).toBe(false);
    expect(diagnostics.anomalies).not.toContain("self-name-configured-but-unmatched");
  });

  it("reads the sender cleanly despite the Verified badge beside the name", async () => {
    // The badge is real in the captured DOM; it must not bleed into the name.
    withSelfName("Vaidurya Shah");
    document.body.innerHTML = unansweredThreadHtml();
    const { context } = await extractLinkedInContext();
    expect(context.messages[0].sender).toBe("Vinay Singhwal");
    expect(context.messages[0].sender).not.toMatch(/verified/i);
  });

  it("STILL warns when a message that could have been mine went unmatched", async () => {
    // A sender who isn't the thread's contact and wasn't recognised as me is a
    // genuine self-detection failure — the case the anomaly exists for.
    withSelfName("Vaidurya Shah");
    document.body.innerHTML = unansweredThreadHtml("Someone Else Entirely");
    const { diagnostics } = await extractLinkedInContext();
    expect(diagnostics.anomalies).toContain("self-name-configured-but-unmatched");
  });

  it("never counts as a layout anomaly either way", async () => {
    withSelfName("Vaidurya Shah");
    document.body.innerHTML = unansweredThreadHtml("Someone Else Entirely");
    const { diagnostics } = await extractLinkedInContext();
    expect(hasLayoutAnomaly(diagnostics.anomalies)).toBe(false);
  });
});

/**
 * A two-party thread, shaped like the live one that exposed this: the signed-in
 * account's name appears in the top-nav "Me" menu AND on the user's own
 * messages, while the configured self-name is a different account's.
 */
function twoPartyThreadHtml(): string {
  return `
    <nav><div class="global-nav__me-photo-wrap">
      <span class="global-nav__me-photo"><img alt="Arun Kumar Maurya" /></span>
    </div></nav>
    <div class="msg-entity-lockup__entity-title">Kushan Lulbadda Waduge</div>
    <div class="msg-s-message-list-container">
      <ul class="msg-s-message-list">
        <li class="msg-s-message-list__event">
          <div class="msg-s-message-group__meta">
            <span class="msg-s-message-group__name">Kushan Lulbadda Waduge</span>
          </div>
          <div class="msg-s-event-listitem">
            <div class="msg-s-event-listitem__body">Thank you so much Arun</div>
          </div>
        </li>
        <li class="msg-s-message-list__event">
          <div class="msg-s-message-group__meta">
            <span class="msg-s-message-group__name">Arun Kumar Maurya</span>
          </div>
          <div class="msg-s-event-listitem">
            <div class="msg-s-event-listitem__body">Glad it helped.</div>
          </div>
        </li>
      </ul>
    </div>`;
}

describe("stale configured self-name recovers from the signed-in account", () => {
  function withSelfName(name: string) {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { sync: { get: vi.fn().mockResolvedValue({ selfName: name }) } },
    };
  }

  it("falls back to the Me-menu name when the configured one matches nothing", async () => {
    // Seen live: the configured name was one account's while messaging
    // attributed the user's own messages to another's, so every message they
    // sent was permanently filed as the contact's.
    withSelfName("Vaidurya Shah");
    document.body.innerHTML = twoPartyThreadHtml();
    const { context, diagnostics } = await extractLinkedInContext();

    const mine = context.messages.filter((m) => m.isSelf);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toBe("Glad it helped.");
    expect(diagnostics.selfDetectionPath).toBe("me-menu-alt");
    // Recovered, so there is nothing to warn about any more.
    expect(diagnostics.anomalies).not.toContain("self-name-configured-but-unmatched");
  });

  it("leaves a WORKING configured name alone", async () => {
    withSelfName("Arun Kumar Maurya");
    document.body.innerHTML = twoPartyThreadHtml();
    const { context, diagnostics } = await extractLinkedInContext();
    expect(diagnostics.selfDetectionPath).toBe("configured-name");
    expect(context.messages.filter((m) => m.isSelf)).toHaveLength(1);
  });

  it("still warns when neither the configured name nor the Me menu matches", async () => {
    withSelfName("Nobody At All");
    document.body.innerHTML = twoPartyThreadHtml().replace('alt="Arun Kumar Maurya"', 'alt="Someone Else"');
    const { diagnostics } = await extractLinkedInContext();
    expect(diagnostics.anomalies).toContain("self-name-configured-but-unmatched");
  });
});
