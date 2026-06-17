/**
 * Voice lint — deterministic, no LLM.
 *
 * The voice profile often states words/phrases the user explicitly avoids
 * ("Avoid: 'circle back', 'synergy'"). A draft that uses one of them contradicts
 * the user's own stated rule, and we can catch that with a plain string check —
 * no model call, no latency, no false confidence. The overlay surfaces hits as a
 * gentle "you usually avoid …" heads-up.
 *
 * Extraction is deliberately CONSERVATIVE to avoid bogus rules: it only mines
 * lines that carry an explicit avoid cue, and within them takes (a) quoted terms
 * and (b) a short comma/semicolon list after a colon. So prose like "I avoid
 * sounding formal" mints nothing unless the term is quoted or listed.
 */

export interface LintViolation {
  /** The avoided term, as normalized for matching (lowercase, unquoted). */
  term: string;
  /** First character index of the match in the linted text. */
  index: number;
}

const AVOID_CUE = /\b(avoid|never use|don'?t use|do not use|steer clear of|stay away from)\b/i;
// Straight and smart quotes.
const QUOTED = /["'“”‘’]([^"'“”‘’\n]{1,40})["'“”‘’]/g;

function norm(s: string): string {
  return s
    .trim()
    .replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Mine the avoided terms from voice-profile text. */
export function extractAvoidTerms(profileText: string): string[] {
  const terms = new Set<string>();
  for (const raw of profileText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!AVOID_CUE.test(line)) continue;

    // (a) quoted terms anywhere on the line.
    for (const m of line.matchAll(QUOTED)) {
      const t = norm(m[1]);
      if (t) terms.add(t);
    }

    // (b) a list after a colon: "avoid: a, b, c" / "never use — x; y".
    const sep = line.search(/[:—]/);
    if (sep >= 0) {
      const list = line.slice(sep + 1).replace(QUOTED, "$1");
      for (const piece of list.split(/[,;]|\band\b/i)) {
        const t = norm(piece);
        // Phrase-like only — don't swallow a whole trailing sentence.
        if (t && t.split(" ").length <= 4) terms.add(t);
      }
    }
  }
  return [...terms];
}

/** Word-boundary-ish match (so "leverage" doesn't fire inside "leveraged"). */
function findTerm(hayLower: string, term: string): number {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).exec(hayLower);
  return m ? m.index : -1;
}

/** Find every avoided term present in `text`. Sorted by position; de-duped. */
export function lintText(avoidTerms: string[], text: string): LintViolation[] {
  const hay = text.toLowerCase();
  const out: LintViolation[] = [];
  const seen = new Set<string>();
  for (const term of avoidTerms) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    const index = findTerm(hay, term);
    if (index >= 0) out.push({ term, index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Prefer a Vocabulary heading block if the compiled profile has one (so we don't
 * mine avoid cues from unrelated prose); otherwise scan the whole document.
 */
function scopeToVocabulary(profile: string): string {
  const lines = profile.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s.*vocab/i.test(l));
  if (start < 0) return profile;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Lint `text` against the avoid rules stated in `profileText`. */
export function lintProfileText(profileText: string, text: string): LintViolation[] {
  if (!profileText || !text.trim()) return [];
  return lintText(extractAvoidTerms(scopeToVocabulary(profileText)), text);
}
