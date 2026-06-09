import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Allowlist of files in voice_profile/ to send to the model.
// Order matters — concatenated in this order.
//
// Raw chat dumps (e.g. linkedin_successful_messages.md) are deliberately NOT
// listed: the model should learn from the distilled analysis only, not from
// the raw conversations themselves.
const VOICE_FILES = [
  "strategy_analysis.md",
] as const;

const VOICE_DIR = resolve(process.cwd(), "..", "voice_profile");

export function loadVoiceProfile(): string {
  if (!existsSync(VOICE_DIR)) return "(no voice profile found)";

  const parts: string[] = [];
  const missing: string[] = [];

  for (const f of VOICE_FILES) {
    const p = join(VOICE_DIR, f);
    if (!existsSync(p)) {
      missing.push(f);
      continue;
    }
    const body = readFileSync(p, "utf-8").trim();
    if (!body) continue;
    parts.push(`# ${f}\n\n${body}`);
  }

  if (missing.length > 0) {
    console.warn(`[voice] missing files (skipped): ${missing.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : "(voice profile is empty)";
}
