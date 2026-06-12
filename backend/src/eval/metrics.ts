/**
 * Pure scoring helpers for the voice-quality eval. No I/O, no LLM — so they're
 * deterministic and unit-tested. The harness (voiceEval.ts) combines these with
 * an LLM judge.
 */

export interface LengthBand {
  p10: number;
  median: number;
  p90: number;
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

/**
 * Split a corpus blob into message-ish chunks: blocks separated by blank lines
 * or `---` rules, with markdown headers/list markers stripped. Filters fragments
 * shorter than a few words (headings, separators).
 */
export function splitCorpus(text: string): string[] {
  return text
    .split(/\n\s*\n|\n-{3,}\n/g)
    .map((b) => b.replace(/^#{1,6}\s.*$/gm, "").replace(/^[-*]\s+/gm, "").trim())
    .filter((b) => b.length > 0 && wordCount(b) >= 4);
}

/** Word-count percentiles for the corpus. Falls back to a sensible band if empty. */
export function corpusLengthBand(messages: string[]): LengthBand {
  const counts = messages.map(wordCount).filter((n) => n > 0).sort((a, b) => a - b);
  if (counts.length === 0) return { p10: 8, median: 35, p90: 90 };
  return { p10: percentile(counts, 10), median: percentile(counts, 50), p90: percentile(counts, 90) };
}

/** 1 inside [p10,p90]; decays linearly to 0 at half p10 / double p90. */
export function lengthFitScore(words: number, band: LengthBand): number {
  if (words >= band.p10 && words <= band.p90) return 1;
  if (words < band.p10) {
    const floor = Math.max(1, band.p10 / 2);
    if (words <= floor) return 0;
    return (words - floor) / (band.p10 - floor);
  }
  const ceil = band.p90 * 2;
  if (words >= ceil) return 0;
  return (ceil - words) / (ceil - band.p90);
}

const CLICHES = [
  "i hope this finds you well",
  "i hope you are doing well",
  "i hope you're doing well",
  "reaching out",
  "wanted to reach out",
  "thought i'd reach out",
  "circle back",
  "touch base",
  "synergy",
  "leverage",
  "low-hanging fruit",
  "move the needle",
  "at your earliest convenience",
  "please find attached",
  "as per my last",
  "i came across your profile",
];

/** 1 = no clichés; each generic tell costs ~0.34 (3+ → 0). */
export function noClicheScore(text: string): { score: number; hits: string[] } {
  const lower = text.toLowerCase();
  const hits = CLICHES.filter((c) => lower.includes(c));
  return { score: Math.max(0, 1 - hits.length * 0.34), hits };
}

/**
 * Pull a 1–5 score from each line of the judge's reply. Takes the LAST single
 * digit 1–5 on the line, so "REPLY 2: 5" yields 5 (the score), not 2 (the index).
 */
export function parseJudgeScores(raw: string): number[] {
  const out: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const ds = line.match(/\b[1-5]\b/g);
    if (ds && ds.length) out.push(Number(ds[ds.length - 1]));
  }
  return out;
}

/** Blend the three signals into a 0–100 score. judge=null → neutral. */
export function composite(p: { judge1to5: number | null; lengthFit: number; cliche: number }): number {
  const judgeNorm = p.judge1to5 == null ? 0.5 : (p.judge1to5 - 1) / 4;
  const blend = 0.5 * judgeNorm + 0.25 * p.lengthFit + 0.25 * p.cliche;
  return Math.round(blend * 100);
}
