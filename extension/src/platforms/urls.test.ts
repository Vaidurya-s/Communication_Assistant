import { describe, it, expect } from "vitest";
import { isSupportedMessagingUrl, isProfileUrl } from "./urls";

describe("isSupportedMessagingUrl", () => {
  it("recognises LinkedIn messaging URLs", () => {
    expect(isSupportedMessagingUrl("https://www.linkedin.com/messaging/thread/2-abc/")).toBe(true);
    expect(isSupportedMessagingUrl("https://www.linkedin.com/messaging/")).toBe(true);
  });

  it("does not treat the feed or a profile as a messaging surface", () => {
    expect(isSupportedMessagingUrl("https://www.linkedin.com/feed/")).toBe(false);
    expect(isSupportedMessagingUrl("https://www.linkedin.com/in/maya-chen/")).toBe(false);
  });

  it("recognises the Gmail app", () => {
    expect(isSupportedMessagingUrl("https://mail.google.com/mail/u/0/#inbox/FMfcgz")).toBe(true);
    expect(isSupportedMessagingUrl("https://mail.google.com/mail/u/0/#inbox")).toBe(true);
  });

  it("ignores unrelated sites, other Google apps, and garbage", () => {
    expect(isSupportedMessagingUrl("https://example.com/messaging/")).toBe(false);
    expect(isSupportedMessagingUrl("https://accounts.google.com/")).toBe(false);
    expect(isSupportedMessagingUrl("https://calendar.google.com/calendar/")).toBe(false);
    expect(isSupportedMessagingUrl("not a url")).toBe(false);
  });
});

describe("isProfileUrl", () => {
  it("recognises LinkedIn profile URLs (with or without trailing slash)", () => {
    expect(isProfileUrl("https://www.linkedin.com/in/maya-chen/")).toBe(true);
    expect(isProfileUrl("https://www.linkedin.com/in/maya-chen")).toBe(true);
  });

  it("rejects non-profile, unrelated, and garbage URLs", () => {
    expect(isProfileUrl("https://www.linkedin.com/messaging/")).toBe(false);
    expect(isProfileUrl("https://example.com/in/foo/")).toBe(false);
    expect(isProfileUrl("")).toBe(false);
  });

  it("treats Gmail as having no profile page", () => {
    expect(isProfileUrl("https://mail.google.com/mail/u/0/#inbox/FMfcgz")).toBe(false);
  });
});
