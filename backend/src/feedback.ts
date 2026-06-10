/**
 * Voice feedback log.
 *
 * The overlay's 👍/👎 on a suggestion calls POST /feedback. We append each
 * entry to voice_profile/feedback.md, a human-readable running log of what
 * sounded right and (more usefully) what was off. `init-voice` reads this file
 * and folds the corrections into a regenerated voice profile, so the assistant
 * improves over time instead of being write-once.
 *
 * The file lives under voice_profile/ — gitignored, personal, never committed.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VOICE_DIR = resolve(process.cwd(), "..", "voice_profile");
export const FEEDBACK_FILE = join(VOICE_DIR, "feedback.md");

export interface FeedbackEntry {
  rating: "up" | "down";
  note?: string;
  contact?: string;
  suggestion?: string;
}

const HEADER =
  "# Voice feedback\n\n" +
  "Running log from 👍/👎 in the overlay. `npm run init-voice` folds the\n" +
  "corrections below into a regenerated voice profile.\n";

export function appendFeedback(entry: FeedbackEntry, nowIso: string): void {
  if (!existsSync(VOICE_DIR)) mkdirSync(VOICE_DIR, { recursive: true });
  if (!existsSync(FEEDBACK_FILE)) writeFileSync(FEEDBACK_FILE, HEADER, "utf-8");

  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [
    "",
    `## ${entry.rating === "up" ? "👍 liked" : "👎 off"} — ${nowIso}`,
    entry.contact ? `- contact: ${oneLine(entry.contact)}` : "",
    entry.note ? `- what was off: ${oneLine(entry.note)}` : "",
    entry.suggestion ? `- suggestion: ${oneLine(entry.suggestion).slice(0, 400)}` : "",
  ].filter(Boolean);

  appendFileSync(FEEDBACK_FILE, lines.join("\n") + "\n", "utf-8");
}

/** Read the feedback log for init-voice, or "" if none. */
export function readFeedback(): string {
  if (!existsSync(FEEDBACK_FILE)) return "";
  try {
    return readFileSync(FEEDBACK_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}
