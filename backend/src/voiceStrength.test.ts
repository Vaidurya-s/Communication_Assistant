import { describe, it, expect } from "vitest";
import { computeStrength, type StrengthInput } from "./voiceStrength.js";

// SECTION_KEYS.length in voiceSections.ts is 8 — use that as the realistic total.
const TOTAL = 8;

/** A fully-empty profile — the cold-start state. */
const EMPTY: StrengthInput = {
  sectionsFilled: 0,
  sectionsTotal: TOTAL,
  profileChars: 0,
  contextConfirmed: 0,
  feedbackCount: 0,
};

/** A fully-developed profile. */
const STRONG: StrengthInput = {
  sectionsFilled: TOTAL,
  sectionsTotal: TOTAL,
  profileChars: 2500,
  contextConfirmed: 5,
  feedbackCount: 4,
};

describe("computeStrength", () => {
  it("empty input → score 0, low label, and nextBest about adding a profile", () => {
    const s = computeStrength(EMPTY);
    expect(s.score).toBe(0);
    expect(s.label).toBe("empty");
    expect(s.nextBest).toMatch(/add your voice profile/i);
    // Every component reports not-ok with a human detail.
    expect(s.breakdown).toHaveLength(4);
    expect(s.breakdown.every((b) => b.ok === false)).toBe(true);
    expect(s.breakdown.every((b) => b.detail.length > 0)).toBe(true);
  });

  it("strong input → high score, label strong/excellent, no nagging nextBest", () => {
    const s = computeStrength(STRONG);
    expect(s.score).toBeGreaterThanOrEqual(90);
    expect(["strong", "excellent"]).toContain(s.label);
    expect(s.nextBest).toBeNull();
    expect(s.breakdown.every((b) => b.ok)).toBe(true);
  });

  it("the voice profile is the highest-leverage first step", () => {
    // Only a profile is missing — coverage/context/feedback maxed.
    const onlyProfileMissing: StrengthInput = {
      sectionsFilled: TOTAL,
      sectionsTotal: TOTAL,
      profileChars: 0,
      contextConfirmed: 5,
      feedbackCount: 4,
    };
    expect(computeStrength(onlyProfileMissing).nextBest).toMatch(/add your voice profile/i);
  });

  it("suggests sections when coverage is the weakest link", () => {
    const s = computeStrength({
      sectionsFilled: 2,
      sectionsTotal: TOTAL,
      profileChars: 2500,
      contextConfirmed: 5,
      feedbackCount: 4,
    });
    expect(s.nextBest).toMatch(/section/i);
  });

  it("suggests About-me context when that is the only gap", () => {
    const s = computeStrength({
      sectionsFilled: TOTAL,
      sectionsTotal: TOTAL,
      profileChars: 2500,
      contextConfirmed: 0,
      feedbackCount: 4,
    });
    expect(s.nextBest).toMatch(/project or achievement/i);
  });

  it("maps scores to the documented label thresholds", () => {
    expect(computeStrength(EMPTY).label).toBe("empty");
    // A thin-but-started profile: a modest profile and a few sections, nothing else.
    const thin = computeStrength({
      sectionsFilled: 3,
      sectionsTotal: TOTAL,
      profileChars: 700,
      contextConfirmed: 0,
      feedbackCount: 0,
    });
    expect(["thin", "solid"]).toContain(thin.label);
    expect(computeStrength(STRONG).label).toMatch(/strong|excellent/);
  });

  it("monotonicity: filling more sections never lowers the score", () => {
    let prev = -1;
    for (let filled = 0; filled <= TOTAL; filled++) {
      const score = computeStrength({
        sectionsFilled: filled,
        sectionsTotal: TOTAL,
        profileChars: 500,
        contextConfirmed: 1,
        feedbackCount: 0,
      }).score;
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("monotonicity: more profile chars never lowers the score", () => {
    let prev = -1;
    for (const chars of [0, 40, 100, 500, 1000, 2000, 5000]) {
      const score = computeStrength({ ...EMPTY, profileChars: chars }).score;
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("score is always clamped to 0–100, even with absurd / negative inputs", () => {
    const huge = computeStrength({
      sectionsFilled: 9999,
      sectionsTotal: TOTAL,
      profileChars: 10_000_000,
      contextConfirmed: 9999,
      feedbackCount: 9999,
    });
    expect(huge.score).toBeLessThanOrEqual(100);
    expect(huge.score).toBeGreaterThanOrEqual(0);

    const negative = computeStrength({
      sectionsFilled: -5,
      sectionsTotal: -1,
      profileChars: -100,
      contextConfirmed: -3,
      feedbackCount: -2,
    });
    expect(negative.score).toBe(0);
    expect(negative.label).toBe("empty");
  });

  it("does not divide-by-zero or NaN when sectionsTotal is 0", () => {
    const s = computeStrength({ ...EMPTY, sectionsTotal: 0, profileChars: 2500, contextConfirmed: 5, feedbackCount: 4 });
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});
