import { describe, it, expect } from "vitest";
import { badgeTextFor, describeDue, parseFollowups } from "./followups";

describe("badgeTextFor", () => {
  it("clears the badge at zero or below", () => {
    expect(badgeTextFor(0)).toBe("");
    expect(badgeTextFor(-1)).toBe("");
  });

  it("shows a small count exactly", () => {
    expect(badgeTextFor(3)).toBe("3");
    expect(badgeTextFor(9)).toBe("9");
  });

  it("caps at 9+ — the badge is a few pixels wide", () => {
    expect(badgeTextFor(10)).toBe("9+");
    expect(badgeTextFor(120)).toBe("9+");
  });

  it("clears rather than rendering NaN", () => {
    expect(badgeTextFor(Number.NaN)).toBe("");
  });
});

describe("describeDue", () => {
  const base = { name: "A", due_on: "2026-08-30", thread_url: null };
  it("phrases today, one day, and many days", () => {
    expect(describeDue({ ...base, days_overdue: 0 })).toBe("due today");
    expect(describeDue({ ...base, days_overdue: 1 })).toBe("1 day overdue");
    expect(describeDue({ ...base, days_overdue: 5 })).toBe("5 days overdue");
  });
});

describe("parseFollowups", () => {
  it("reads a well-formed response", () => {
    const out = parseFollowups({
      followups: [{ name: "Reed", due_on: "2026-08-29", days_overdue: 1, thread_url: "https://x/1" }],
    });
    expect(out).toEqual([
      { name: "Reed", due_on: "2026-08-29", days_overdue: 1, thread_url: "https://x/1" },
    ]);
  });

  it("survives anything the backend might return", () => {
    // The extension can be pointed at a backend of any version, so a shape
    // mismatch must degrade to "no follow-ups", never throw in a poll loop.
    expect(parseFollowups(null)).toEqual([]);
    expect(parseFollowups({})).toEqual([]);
    expect(parseFollowups({ followups: "nope" })).toEqual([]);
    expect(parseFollowups({ followups: [null, 3, "x"] })).toEqual([]);
  });

  it("drops entries with no name and defaults missing fields", () => {
    const out = parseFollowups({ followups: [{ name: "" }, { name: "Ok" }] });
    expect(out).toEqual([{ name: "Ok", due_on: "", days_overdue: 0, thread_url: null }]);
  });
});
