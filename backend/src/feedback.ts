/**
 * Voice feedback log.
 *
 * The overlay's 👍/👎 on a suggestion calls POST /feedback. We append each
 * entry to the tenant's voice_profile/feedback.md, a human-readable running log
 * of what sounded right and (more usefully) what was off. `init-voice` reads
 * this file and folds the corrections into a regenerated voice profile, so the
 * assistant improves over time instead of being write-once.
 *
 * The file lives under the tenant's voice_profile/ directory (for the local
 * tenant that's the repo-root voice_profile/ — gitignored, personal, never
 * committed).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TENANT } from "./tenant.js";
import { voiceDirFor } from "./voiceProfile.js";

/** Absolute path to a tenant's feedback log. */
export function feedbackFilePath(tenantId: string = DEFAULT_TENANT): string {
  return join(voiceDirFor(tenantId), "feedback.md");
}

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

export function appendFeedback(
  tenantId: string,
  entry: FeedbackEntry,
  nowIso: string,
): void {
  const dir = voiceDirFor(tenantId);
  const file = join(dir, "feedback.md");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, HEADER, "utf-8");

  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [
    "",
    `## ${entry.rating === "up" ? "👍 liked" : "👎 off"} — ${nowIso}`,
    entry.contact ? `- contact: ${oneLine(entry.contact)}` : "",
    entry.note ? `- what was off: ${oneLine(entry.note)}` : "",
    entry.suggestion ? `- suggestion: ${oneLine(entry.suggestion).slice(0, 400)}` : "",
  ].filter(Boolean);

  appendFileSync(file, lines.join("\n") + "\n", "utf-8");
}

/** Read the feedback log for init-voice, or "" if none. */
export function readFeedback(tenantId: string = DEFAULT_TENANT): string {
  const file = feedbackFilePath(tenantId);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

export interface ParsedFeedback {
  rating: "up" | "down";
  date: string;
  contact?: string;
  note?: string;
  suggestion?: string;
}

/**
 * Parse feedback.md back into structured entries for the console's Voice
 * section. Mirrors the block shape written by appendFeedback():
 *   ## 👍 liked — <iso>   /   ## 👎 off — <iso>
 *   - contact: ...
 *   - what was off: ...
 *   - suggestion: ...
 * Newest first.
 */
export function readFeedbackEntries(tenantId: string = DEFAULT_TENANT): ParsedFeedback[] {
  const raw = readFeedback(tenantId);
  if (!raw) return [];
  const entries: ParsedFeedback[] = [];
  const blocks = raw.split(/\n(?=## )/);
  for (const block of blocks) {
    const header = block.match(/^##\s*(👍|👎)[^\n]*?—\s*(.+)$/m);
    if (!header) continue;
    const rating = header[1] === "👍" ? "up" : "down";
    const date = header[2].trim();
    const field = (label: RegExp): string | undefined => {
      const m = block.match(label);
      return m ? m[1].trim() : undefined;
    };
    entries.push({
      rating,
      date,
      contact: field(/^-\s*contact:\s*(.+)$/m),
      note: field(/^-\s*what was off:\s*(.+)$/m),
      suggestion: field(/^-\s*suggestion:\s*(.+)$/m),
    });
  }
  entries.reverse();
  return entries;
}
