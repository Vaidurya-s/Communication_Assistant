/**
 * Voice-strength model (plan §14 "Voice-strength model").
 *
 * Turns the abstract voice profile into a single concrete 0–100 score plus a
 * per-component breakdown and the single highest-leverage "next best thing to
 * add." It replaces the binary boot check: it drives onboarding (a ladder, not a
 * wall) and gates quality messaging ("your voice is thin — replies may sound
 * generic").
 *
 * PURE logic only — every signal is passed in (no db / LLM / fs). Callers
 * (server.ts `GET /voice/strength`) gather the inputs: `sectionsFilled` from
 * voiceSections, `profileChars` from the compiled profile, `contextConfirmed`
 * from context.ts, `feedbackCount` from feedback.
 */

/** Raw signals about how developed a tenant's voice profile is. */
export interface StrengthInput {
  /** Non-empty voice sections (see voiceSections SECTION_KEYS). */
  sectionsFilled: number;
  /** Total canonical sections (SECTION_KEYS.length). */
  sectionsTotal: number;
  /** Character length of the compiled runtime profile (strategy_analysis.md). */
  profileChars: number;
  /** Confirmed personal-context items (projects, achievements, bio, …). */
  contextConfirmed: number;
  /** Feedback corrections folded into the profile so far. */
  feedbackCount: number;
}

/** One scored component, surfaced in the dashboard as a checklist row. */
export interface StrengthBreakdownItem {
  label: string;
  /** True once this component clears its "good enough" bar. */
  ok: boolean;
  /** Human-readable status, e.g. "5/8 sections filled". */
  detail: string;
}

export interface VoiceStrength {
  /** 0–100, always clamped. */
  score: number;
  /** Bucketed label, see thresholds below. */
  label: string;
  /** Single highest-leverage next action, or null when already strong. */
  nextBest: string | null;
  breakdown: StrengthBreakdownItem[];
}

/**
 * Component weights — sum to 100. A component contributes
 * `weight * fraction(0..1)` to the score. Documented per-component below.
 */
const WEIGHTS = {
  profile: 35, // compiled profile present & substantial
  coverage: 30, // section coverage
  context: 20, // personal context items (diminishing returns)
  feedback: 15, // feedback incorporated (small bonus)
} as const;

/** "Good enough" bars for the per-component `ok` flag. */
const PROFILE_MIN_CHARS = 40; // below this the profile is effectively empty
const PROFILE_FULL_CHARS = 2000; // a substantial, fully-developed profile
const CONTEXT_CAP = 4; // diminishing returns past this many items
const FEEDBACK_CAP = 3; // small bonus, capped quickly

/** Label thresholds. score < 15 empty, < 40 thin, < 70 solid, < 90 strong, else excellent. */
function labelFor(score: number): string {
  if (score < 15) return "empty";
  if (score < 40) return "thin";
  if (score < 70) return "solid";
  if (score < 90) return "strong";
  return "excellent";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

/**
 * Profile-substance fraction (0..1). 0 chars → 0; below PROFILE_MIN_CHARS counts
 * as effectively nothing; then scales linearly from the min up to a cap around
 * PROFILE_FULL_CHARS, where it saturates at 1.
 */
function profileFraction(chars: number): number {
  if (chars < PROFILE_MIN_CHARS) return 0;
  return clamp01((chars - PROFILE_MIN_CHARS) / (PROFILE_FULL_CHARS - PROFILE_MIN_CHARS));
}

/** Context fraction with diminishing returns — each item up to CONTEXT_CAP is worth an equal share. */
function contextFraction(items: number): number {
  return clamp01(items / CONTEXT_CAP);
}

/** Feedback fraction — a quick-saturating small bonus. */
function feedbackFraction(count: number): number {
  return clamp01(count / FEEDBACK_CAP);
}

/** Coverage fraction — filled sections over total (guarded against a zero/garbage total). */
function coverageFraction(filled: number, total: number): number {
  if (total <= 0) return 0;
  return clamp01(filled / total);
}

/**
 * Compute the voice-strength summary from raw signals. Pure; deterministic.
 *
 * Score = Σ weight_i · fraction_i, rounded and clamped to 0–100. `nextBest` is
 * the action attached to the weakest *not-yet-ok* component, picked by largest
 * remaining headroom (weight · (1 − fraction)) so it's the most impactful single
 * step. Returns null once nothing material is left to add.
 */
export function computeStrength(input: StrengthInput): VoiceStrength {
  const sectionsTotal = input.sectionsTotal > 0 ? input.sectionsTotal : 0;
  const sectionsFilled = Math.max(0, Math.min(input.sectionsFilled, sectionsTotal || input.sectionsFilled));
  const profileChars = Math.max(0, input.profileChars || 0);
  const contextConfirmed = Math.max(0, input.contextConfirmed || 0);
  const feedbackCount = Math.max(0, input.feedbackCount || 0);

  const fProfile = profileFraction(profileChars);
  const fCoverage = coverageFraction(sectionsFilled, sectionsTotal);
  const fContext = contextFraction(contextConfirmed);
  const fFeedback = feedbackFraction(feedbackCount);

  const raw =
    WEIGHTS.profile * fProfile +
    WEIGHTS.coverage * fCoverage +
    WEIGHTS.context * fContext +
    WEIGHTS.feedback * fFeedback;

  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const sectionsRemaining = Math.max(0, (sectionsTotal || 0) - sectionsFilled);

  const breakdown: StrengthBreakdownItem[] = [
    {
      label: "Voice profile",
      ok: fProfile >= 0.5,
      detail:
        profileChars < PROFILE_MIN_CHARS
          ? "No compiled voice profile yet"
          : `Compiled profile: ${profileChars} chars`,
    },
    {
      label: "Section coverage",
      ok: fCoverage >= 0.5,
      detail: sectionsTotal > 0 ? `${sectionsFilled}/${sectionsTotal} sections filled` : "No sections",
    },
    {
      label: "About-me context",
      ok: contextConfirmed >= 1,
      detail:
        contextConfirmed === 0
          ? "No projects or achievements added"
          : `${contextConfirmed} context item${contextConfirmed === 1 ? "" : "s"}`,
    },
    {
      label: "Feedback incorporated",
      ok: feedbackCount >= 1,
      detail: feedbackCount === 0 ? "No feedback applied yet" : `${feedbackCount} correction${feedbackCount === 1 ? "" : "s"} applied`,
    },
  ];

  // nextBest: the not-yet-good component with the most remaining score headroom
  // (weight · (1 − fraction)). Each candidate carries a concrete, actionable
  // suggestion. If everything material is satisfied, return null.
  const candidates: { headroom: number; suggestion: string }[] = [];

  if (fProfile < 1) {
    const suggestion =
      profileChars < PROFILE_MIN_CHARS
        ? "Add your voice profile (paste a few messages)"
        : "Develop your voice profile further (paste more messages or regenerate sections)";
    candidates.push({ headroom: WEIGHTS.profile * (1 - fProfile), suggestion });
  }
  if (fCoverage < 1 && sectionsRemaining > 0) {
    const suggestion =
      sectionsRemaining === 1
        ? "Fill in your last empty section (e.g. how you close)"
        : `Fill in ${sectionsRemaining} more section${sectionsRemaining === 1 ? "" : "s"} (e.g. how you close)`;
    candidates.push({ headroom: WEIGHTS.coverage * (1 - fCoverage), suggestion });
  }
  if (fContext < 1) {
    const suggestion =
      contextConfirmed === 0
        ? "Add a project or achievement to About-me"
        : "Add another project or achievement to About-me";
    candidates.push({ headroom: WEIGHTS.context * (1 - fContext), suggestion });
  }
  if (fFeedback < 1) {
    candidates.push({
      headroom: WEIGHTS.feedback * (1 - fFeedback),
      suggestion: "Rate a few drafts so your voice can learn from corrections",
    });
  }

  // Most-impactful first. A tiny epsilon of headroom (already-strong profile)
  // isn't worth nagging about, so suppress trivial suggestions.
  candidates.sort((a, b) => b.headroom - a.headroom);
  const top = candidates[0];
  const nextBest = top && top.headroom >= 1 ? top.suggestion : null;

  return { score, label: labelFor(score), nextBest, breakdown };
}
