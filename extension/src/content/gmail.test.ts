import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractGmailContext } from "./gmail";

// extractGmailContext reads getSelfNameSetting() → chrome.storage.sync. Stub it.
beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { sync: { get: vi.fn().mockResolvedValue({}) } },
  };
  document.title = "(no subject) - me@gmail.com - Gmail";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("gmail extraction", () => {
  it("recovers the thread when the body is entirely quoted (the gmail-zero-messages bug)", async () => {
    // A single message whose body is ONLY a nested quote chain — no new text
    // above the quote. Previously dropped → 0 messages → couldn't draft.
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP">(no subject)</h2>
        <div data-message-id="m1">
          <span class="gD" email="me@gmail.com" name="Me Self">Me Self</span>
          <div class="a3s">
            <div class="gmail_quote">
              <div class="gmail_attr">On Thu, May 21, 2026 at 1:01 PM Me Self &lt;me@gmail.com&gt; wrote:</div>
              <blockquote class="gmail_quote">
                <div>my earlier note</div>
                <div class="gmail_quote">
                  <div class="gmail_attr">On Thu, May 21, 2026 at 12:45 PM Other Person &lt;other@example.com&gt; wrote:</div>
                  <blockquote class="gmail_quote"><div>foo foo</div></blockquote>
                </div>
              </blockquote>
            </div>
          </div>
        </div>
      </div>`;

    const { context, diagnostics } = await extractGmailContext();

    expect(context.messages.length).toBe(1);
    expect(diagnostics.anomalies).not.toContain("gmail-zero-messages");
    // Attributed to the most recent OTHER party (not the self wrapper sender).
    expect(context.conversation_title).toBe("Other Person");
    expect(context.messages[0].isSelf).toBe(false);
    // The quoted conversation content is retained for the model to reply to.
    expect(context.messages[0].text).toContain("foo foo");
  });

  it("still strips a trailing quote for a normal message with new text", async () => {
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP">Re: project</h2>
        <div data-message-id="m1">
          <span class="gD" email="other@example.com" name="Other Person">Other Person</span>
          <div class="a3s">
            <div>Here is my actual reply.</div>
            <div class="gmail_quote">
              <div class="gmail_attr">On Thu Me Self &lt;me@gmail.com&gt; wrote:</div>
              <blockquote class="gmail_quote"><div>older stuff</div></blockquote>
            </div>
          </div>
        </div>
      </div>`;

    const { context } = await extractGmailContext();
    expect(context.messages.length).toBe(1);
    expect(context.messages[0].text).toContain("Here is my actual reply.");
    expect(context.messages[0].text).not.toContain("older stuff");
    expect(context.conversation_title).toBe("Other Person");
  });
});
