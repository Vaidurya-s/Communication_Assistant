import { describe, it, expect } from "vitest";
import { dueFollowups, type FollowupCandidate } from "./followups.js";

function c(name: string, at: string | null, url: string | null = null): FollowupCandidate {
  return { name, suggested_followup_at: at, last_thread_url: url };
}

const TODAY = "2026-08-30T14:30:00.000Z";

describe("dueFollowups", () => {
  it("includes a follow-up dated today, all day", () => {
    // Due today means due all day — not from midnight-plus-one-second. The
    // caller's clock is mid-afternoon here and it must still count.
    const out = dueFollowups([c("Today", "2026-08-30")], TODAY);
    expect(out).toHaveLength(1);
    expect(out[0].days_overdue).toBe(0);
  });

  it("includes overdue ones and counts the days", () => {
    const out = dueFollowups([c("Late", "2026-08-27")], TODAY);
    expect(out[0].days_overdue).toBe(3);
  });

  it("excludes future follow-ups", () => {
    expect(dueFollowups([c("Later", "2026-09-05")], TODAY)).toEqual([]);
  });

  it("sorts most overdue first, then by name", () => {
    const out = dueFollowups(
      [c("B", "2026-08-30"), c("Ancient", "2026-01-01"), c("A", "2026-08-30")],
      TODAY,
    );
    expect(out.map((f) => f.name)).toEqual(["Ancient", "A", "B"]);
  });

  it("accepts a full ISO datetime, not just YYYY-MM-DD", () => {
    // setFollowupAt stores whatever it's handed, so both shapes turn up.
    expect(dueFollowups([c("Full", "2026-08-29T09:15:00.000Z")], TODAY)).toHaveLength(1);
  });

  it("skips null and malformed dates rather than nagging forever", () => {
    const out = dueFollowups(
      [c("None", null), c("Junk", "sometime next week"), c("Empty", "")],
      TODAY,
    );
    expect(out).toEqual([]);
  });

  it("carries the thread url through so the badge leads somewhere", () => {
    const out = dueFollowups([c("X", "2026-08-30", "https://linkedin.com/messaging/thread/1")], TODAY);
    expect(out[0].thread_url).toContain("/messaging/thread/1");
  });

  it("returns [] when the caller's own clock is unusable", () => {
    expect(dueFollowups([c("X", "2026-08-30")], "not a date")).toEqual([]);
  });
});
