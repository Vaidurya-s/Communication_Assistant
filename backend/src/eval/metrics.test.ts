import { describe, it, expect } from "vitest";
import {
  composite,
  corpusLengthBand,
  lengthFitScore,
  noClicheScore,
  parseJudgeScores,
  splitCorpus,
} from "./metrics.js";

describe("voice-eval metrics", () => {
  it("computes an ordered length band", () => {
    const band = corpusLengthBand(["one two three four five", "a b c d e f", "w ".repeat(50).trim()]);
    expect(band.p10).toBeLessThanOrEqual(band.median);
    expect(band.median).toBeLessThanOrEqual(band.p90);
  });

  it("falls back to a default band when the corpus is empty", () => {
    const band = corpusLengthBand([]);
    expect(band.p90).toBeGreaterThan(band.p10);
  });

  it("scores length fit 1 inside the band and 0 well outside", () => {
    const band = { p10: 10, median: 30, p90: 60 };
    expect(lengthFitScore(30, band)).toBe(1);
    expect(lengthFitScore(120, band)).toBe(0); // >= 2 * p90
    expect(lengthFitScore(5, band)).toBe(0); // <= p10 / 2
    expect(lengthFitScore(8, band)).toBeGreaterThan(0);
    expect(lengthFitScore(8, band)).toBeLessThan(1);
  });

  it("flags clichés and passes clean text", () => {
    expect(noClicheScore("I hope this finds you well, reaching out to touch base").score).toBeLessThan(0.5);
    expect(noClicheScore("Saw your post on FPGA timing — sharp take.").score).toBe(1);
  });

  it("parses judge scores by score, not by index", () => {
    expect(parseJudgeScores("REPLY 1: 4\nREPLY 2: 5/5\nREPLY 3: 2")).toEqual([4, 5, 2]);
    expect(parseJudgeScores("1. 3\n2. 4")).toEqual([3, 4]);
  });

  it("composites a 0–100 score, monotonic in the judge", () => {
    expect(composite({ judge1to5: 5, lengthFit: 1, cliche: 1 })).toBeGreaterThan(
      composite({ judge1to5: 1, lengthFit: 1, cliche: 1 }),
    );
    expect(composite({ judge1to5: null, lengthFit: 1, cliche: 1 })).toBeGreaterThan(0);
  });

  it("splits a corpus blob into message-ish chunks", () => {
    const chunks = splitCorpus(
      "# Header\n\nHey there how are you doing today\n\n---\n\nThanks for the intro really appreciate it",
    );
    expect(chunks).toHaveLength(2);
  });
});
