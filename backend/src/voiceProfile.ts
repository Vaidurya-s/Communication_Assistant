import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// The single canonical compiled voice profile. Other companion files
// (boundaries.md, tone.md, writing_patterns.md, etc.) are editable source
// inputs that the user periodically compiles down into this artifact; the
// backend does not read them directly. Keeping the runtime profile single-
// file avoids prompt bloat and a single trust boundary.
const REQUIRED_VOICE_FILE = "strategy_analysis.md";

// Files we deliberately do NOT load (raw chat corpus). Listed here only as
// documentation — `linkedin_successful_messages.md` is exposed to gemini's
// grep tool through the sandbox workspace, not concatenated into the prompt.

const VOICE_DIR = resolve(process.cwd(), "..", "voice_profile");
const TEMPLATE_PATH = `voice_profile/templates/${REQUIRED_VOICE_FILE}.template`;

export class VoiceProfileMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceProfileMissingError";
  }
}

function buildMissingError(reason: "dir-missing" | "file-missing" | "file-empty"): VoiceProfileMissingError {
  const detail =
    reason === "dir-missing"
      ? `voice_profile/ directory not found at ${VOICE_DIR}`
      : reason === "file-empty"
        ? `${REQUIRED_VOICE_FILE} exists but is empty`
        : `${REQUIRED_VOICE_FILE} not found in ${VOICE_DIR}`;
  return new VoiceProfileMissingError(
    [
      "Voice profile is missing — backend cannot start.",
      detail,
      "",
      "To fix:",
      `  cp ${TEMPLATE_PATH} voice_profile/${REQUIRED_VOICE_FILE}`,
      "  # then open it and replace the placeholder sections with your own distillation",
      "",
      "See voice_profile/templates/README.md for details.",
    ].join("\n"),
  );
}

/**
 * Throws a VoiceProfileMissingError if the required runtime profile is not
 * present and non-empty. Called at server startup so we fail loudly rather
 * than silently degrading reply quality.
 */
export function validateVoiceProfile(): void {
  if (!existsSync(VOICE_DIR)) throw buildMissingError("dir-missing");
  const path = join(VOICE_DIR, REQUIRED_VOICE_FILE);
  if (!existsSync(path)) throw buildMissingError("file-missing");
  const body = readFileSync(path, "utf-8").trim();
  if (!body) throw buildMissingError("file-empty");
}

/**
 * Read the compiled voice profile. Returns its body. Assumes
 * validateVoiceProfile() has already been called at boot — if the file
 * vanishes between boot and an /analyze call (rare), this falls back to a
 * marker string rather than crashing the request.
 */
export function loadVoiceProfile(): string {
  const path = join(VOICE_DIR, REQUIRED_VOICE_FILE);
  if (!existsSync(path)) return "(voice profile missing — restart backend)";
  const body = readFileSync(path, "utf-8").trim();
  return body || "(voice profile is empty)";
}

/** Absolute path to the compiled voice profile (for stat/mtime in the console). */
export function voiceProfilePath(): string {
  return join(VOICE_DIR, REQUIRED_VOICE_FILE);
}
