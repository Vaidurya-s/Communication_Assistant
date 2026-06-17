/**
 * Guided onboarding interview (deterministic, no LLM).
 *
 * A fixed set of free-text questions whose answers map DIRECTLY to the two
 * onboarding layers (plan §8 "Guided interview"):
 *
 *   - voice sections   → written via `saveSection(..., "interview")`
 *   - personal context → created as PROPOSED items (confirmed=0) via
 *                        `addContextItem`, awaiting confirmation in the dashboard
 *
 * No model call keeps this fast, reliable, and unit-testable; the mapping is a
 * pure function of the answers. The user refines the results afterward — section
 * bodies are editable and proposed context items must be confirmed before they
 * reach the prompt (same trust gate as memory notes).
 *
 * Wiring (in server.ts, owned elsewhere):
 *   - GET  /onboarding/interview → returns INTERVIEW_QUESTIONS
 *   - POST /onboarding/interview → { answers } → applyInterview(tenant, answers)
 */
import { addContextItem, type ContextType } from "./context.js";
import { saveSection, type SectionKey } from "./voiceSections.js";

export interface InterviewQuestion {
  id: string;
  prompt: string;
  hint?: string;
  target:
    | { kind: "section"; key: SectionKey }
    | { kind: "context"; type: ContextType; multiline?: boolean };
}

/**
 * The fixed interview. Covers both layers: four voice sections and four context
 * types. `multiline` context questions yield one item per non-empty line.
 */
export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    id: "registers",
    prompt: "How do you open a message to someone senior vs. a peer?",
    hint: "e.g. a formal greeting for execs, first-name and casual for peers.",
    target: { kind: "section", key: "registers" },
  },
  {
    id: "vocabulary",
    prompt: "Any words or phrases you never use?",
    hint: "Buzzwords or filler you actively avoid, e.g. \"circle back\", \"synergy\".",
    target: { kind: "section", key: "vocabulary" },
  },
  {
    id: "closings",
    prompt: "How do you usually sign off / close?",
    hint: "Your typical closing line and sign-off.",
    target: { kind: "section", key: "closings" },
  },
  {
    id: "disagreeing",
    prompt: "How do you push back or disagree?",
    hint: "How you raise a concern or say no without burning the relationship.",
    target: { kind: "section", key: "disagreeing" },
  },
  {
    id: "projects",
    prompt: "Name a project or two you'd mention when introducing yourself (one per line).",
    hint: "One project per line — each becomes a separate item to confirm.",
    target: { kind: "context", type: "project", multiline: true },
  },
  {
    id: "achievement",
    prompt: "A recent achievement you're proud of?",
    target: { kind: "context", type: "achievement" },
  },
  {
    id: "bio",
    prompt: "A one-line bio.",
    target: { kind: "context", type: "bio" },
  },
  {
    id: "looking_for",
    prompt: "What are you looking for right now? (roles, collaborators, …)",
    target: { kind: "context", type: "looking_for" },
  },
];

/** Fixed labels for single-line context targets, keyed by context type. */
const CONTEXT_LABELS: Record<ContextType, string> = {
  project: "Project",
  achievement: "Achievement",
  bio: "Bio",
  looking_for: "Looking for",
};

/** A short title derived from a line: its first ~6 words, trimmed. */
function deriveTitle(line: string): string {
  return line.trim().split(/\s+/).slice(0, 6).join(" ");
}

export interface ApplyInterviewResult {
  sectionsWritten: SectionKey[];
  contextCreated: number;
}

/**
 * Map free-text answers onto voice sections and proposed context items.
 *
 * For each question with a non-empty trimmed answer:
 *   - section target  → saveSection(..., "interview"); the key is recorded.
 *     The vocabulary answer is stored with an "Avoid: " prefix.
 *   - context target  → addContextItem(..., { confirmed: 0 }). A multiline
 *     target creates one item per non-empty line (title = first ~6 words,
 *     body = the full line); a single-line target creates one item with a
 *     fixed label as title and the answer as body.
 *
 * Unknown question ids and empty answers are ignored. The backend rejects an
 * empty title/body, so we never call addContextItem with an empty body.
 */
export function applyInterview(
  tenantId: string,
  answers: Record<string, string>,
): ApplyInterviewResult {
  const sectionsWritten: SectionKey[] = [];
  let contextCreated = 0;

  for (const q of INTERVIEW_QUESTIONS) {
    const raw = answers[q.id];
    if (typeof raw !== "string") continue;
    const answer = raw.trim();
    if (!answer) continue;

    if (q.target.kind === "section") {
      const body = q.target.key === "vocabulary" ? `Avoid: ${answer}` : answer;
      saveSection(tenantId, q.target.key, body, "interview");
      sectionsWritten.push(q.target.key);
      continue;
    }

    // Context target — proposed items (confirmed=0).
    const { type, multiline } = q.target;
    if (multiline) {
      const lines = answer
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const line of lines) {
        addContextItem(tenantId, {
          type,
          title: deriveTitle(line),
          body: line,
          confirmed: 0,
        });
        contextCreated += 1;
      }
    } else {
      addContextItem(tenantId, {
        type,
        title: CONTEXT_LABELS[type],
        body: answer,
        confirmed: 0,
      });
      contextCreated += 1;
    }
  }

  return { sectionsWritten, contextCreated };
}
