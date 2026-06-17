import { describe, expect, it } from "vitest";
import { extractAvoidTerms, lintText, lintProfileText } from "./voiceLint.js";

describe("extractAvoidTerms", () => {
  it("pulls quoted terms from an avoid-cue line", () => {
    const terms = extractAvoidTerms(`I avoid "circle back" and 'synergy' in messages.`);
    expect(terms).toEqual(expect.arrayContaining(["circle back", "synergy"]));
  });

  it("pulls a comma list after a colon", () => {
    const terms = extractAvoidTerms("Avoid: leverage, touch base, low-hanging fruit");
    expect(terms).toEqual(expect.arrayContaining(["leverage", "touch base", "low-hanging fruit"]));
  });

  it("ignores avoid prose that names no concrete term", () => {
    // No quote, no colon list → nothing minted (don't invent 'sounding formal').
    expect(extractAvoidTerms("I avoid sounding overly formal with peers.")).toEqual([]);
  });

  it("does not mine non-avoid lines", () => {
    expect(extractAvoidTerms("Use: warm, direct, concrete.")).toEqual([]);
  });

  it("handles the 'never use' cue and em-dash separator", () => {
    expect(extractAvoidTerms("Never use — moving forward; per my last email")).toEqual(
      expect.arrayContaining(["moving forward", "per my last email"]),
    );
  });
});

describe("lintText", () => {
  it("flags an avoided term present in the draft", () => {
    const v = lintText(["circle back", "synergy"], "Let's circle back next week.");
    expect(v).toHaveLength(1);
    expect(v[0].term).toBe("circle back");
    expect(v[0].index).toBe("Let's ".length);
  });

  it("respects word boundaries (no match inside a larger word)", () => {
    expect(lintText(["leverage"], "We leveraged the new tooling.")).toEqual([]);
    expect(lintText(["leverage"], "We leverage the new tooling.")).toHaveLength(1);
  });

  it("is case-insensitive and de-dupes terms", () => {
    const v = lintText(["synergy", "synergy"], "SYNERGY is overused.");
    expect(v).toHaveLength(1);
  });

  it("returns nothing for a clean draft", () => {
    expect(lintText(["circle back"], "Sounds good — talk soon.")).toEqual([]);
  });
});

describe("lintProfileText", () => {
  const profile = [
    "## How I open",
    "Short, no greeting.",
    "",
    "## Vocabulary",
    'Use: warm, concrete. Avoid: "circle back", synergy.',
    "",
    "## How I close",
    "I avoid 'cheers' as a sign-off.", // outside Vocabulary → not scoped in
  ].join("\n");

  it("lints against the Vocabulary section's avoid rules", () => {
    const v = lintProfileText(profile, "Great — let's circle back and find synergy.");
    expect(v.map((x) => x.term)).toEqual(["circle back", "synergy"]);
  });

  it("scopes to the Vocabulary heading, ignoring avoid cues elsewhere", () => {
    // 'cheers' is only avoided under "How I close", which is out of scope.
    expect(lintProfileText(profile, "Cheers, talk soon.")).toEqual([]);
  });

  it("returns nothing for empty inputs", () => {
    expect(lintProfileText("", "circle back")).toEqual([]);
    expect(lintProfileText(profile, "   ")).toEqual([]);
  });
});
