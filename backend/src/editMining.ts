/**
 * Edit-mining store.
 *
 * The gap between what the assistant suggested and what the user actually sent
 * (after editing the draft in the overlay) is the most honest voice signal we
 * have — it's a real correction the user made by hand. When the overlay's
 * opt-in edit-mining is on, each such (before → after) pair is POSTed here and
 * appended to the tenant's voice_profile/edits.md.
 *
 * These accumulate as candidate corrections; `editsAsCorrections()` renders them
 * into the same "corrections" block the feedback-apply distill already folds in,
 * so applying corrections learns from edits as well as 👍/👎 notes.
 *
 * On-device by design: like feedback.md, edits.md lives under the tenant's
 * voice_profile/ dir (gitignored for the local tenant) and never leaves the box.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TENANT } from "./tenant.js";
import { voiceDirFor } from "./voiceProfile.js";

export interface EditEntry {
  before: string; // the assistant's suggestion
  after: string; // what the user actually copied
  contact?: string;
}

export interface ParsedEdit extends EditEntry {
  date: string;
}

const HEADER =
  "# Edit log (candidate voice corrections)\n\n" +
  "Captured from the overlay when edit-mining is ON: the diff between a suggested\n" +
  "draft and what you actually copied. `Apply corrections` folds these into a\n" +
  "regenerated voice profile.\n";

export function editsFilePath(tenantId: string = DEFAULT_TENANT): string {
  return join(voiceDirFor(tenantId), "edits.md");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function appendEdit(tenantId: string, entry: EditEntry, nowIso: string): void {
  const dir = voiceDirFor(tenantId);
  const file = join(dir, "edits.md");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, HEADER, "utf-8");

  const lines = [
    "",
    `## edit — ${nowIso}`,
    entry.contact ? `- contact: ${oneLine(entry.contact)}` : "",
    `- suggested: ${oneLine(entry.before).slice(0, 600)}`,
    `- sent: ${oneLine(entry.after).slice(0, 600)}`,
  ].filter(Boolean);

  appendFileSync(file, lines.join("\n") + "\n", "utf-8");
}

export function readEdits(tenantId: string = DEFAULT_TENANT): string {
  const file = editsFilePath(tenantId);
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

/** Parse edits.md back into structured entries (newest first). */
export function readEditEntries(tenantId: string = DEFAULT_TENANT): ParsedEdit[] {
  const raw = readEdits(tenantId);
  if (!raw) return [];
  const entries: ParsedEdit[] = [];
  for (const block of raw.split(/\n(?=## )/)) {
    const header = block.match(/^##\s*edit\s*—\s*(.+)$/m);
    if (!header) continue;
    const field = (label: RegExp): string | undefined => {
      const m = block.match(label);
      return m ? m[1].trim() : undefined;
    };
    const before = field(/^-\s*suggested:\s*(.+)$/m);
    const after = field(/^-\s*sent:\s*(.+)$/m);
    if (!before || !after) continue;
    entries.push({
      date: header[1].trim(),
      contact: field(/^-\s*contact:\s*(.+)$/m),
      before,
      after,
    });
  }
  entries.reverse();
  return entries;
}

/**
 * Render captured edits as a corrections block for the distill prompt. Shows the
 * model the before→after pairs so it can absorb the user's manual fixes. Returns
 * "" when there are none. Capped so a long log can't blow the prompt budget.
 */
export function editsAsCorrections(tenantId: string = DEFAULT_TENANT, max = 20): string {
  const entries = readEditEntries(tenantId).slice(0, max);
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) => `- I changed "${e.before}" → "${e.after}"`,
  );
  return "My hand-edits to suggested drafts (prefer how I rewrote them):\n" + lines.join("\n");
}
