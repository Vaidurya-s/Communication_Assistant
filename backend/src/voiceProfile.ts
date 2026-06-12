import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TENANT, safeTenant } from "./tenant.js";

// The single canonical compiled voice profile. Other companion files
// (boundaries.md, tone.md, writing_patterns.md, etc.) are editable source
// inputs that the user periodically compiles down into this artifact; the
// backend does not read them directly. Keeping the runtime profile single-
// file avoids prompt bloat and a single trust boundary.
const REQUIRED_VOICE_FILE = "strategy_analysis.md";

// Files we deliberately do NOT load (raw chat corpus). Listed here only as
// documentation — `linkedin_successful_messages.md` is exposed to gemini's
// grep tool through the sandbox workspace, not concatenated into the prompt.

const TEMPLATE_PATH = `voice_profile/templates/${REQUIRED_VOICE_FILE}.template`;

/**
 * The directory holding a tenant's voice profile.
 *
 * The local (single-user) tenant keeps the original repo-root `voice_profile/`
 * directory, so existing installs are byte-for-byte unchanged. Every other
 * tenant gets an isolated directory under `backend/data/tenants/<id>/`.
 */
export function voiceDirFor(tenantId: string = DEFAULT_TENANT): string {
  if (tenantId === DEFAULT_TENANT) return resolve(process.cwd(), "..", "voice_profile");
  return resolve(process.cwd(), "data", "tenants", safeTenant(tenantId), "voice_profile");
}

export class VoiceProfileMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceProfileMissingError";
  }
}

function buildMissingError(
  voiceDir: string,
  reason: "dir-missing" | "file-missing" | "file-empty",
): VoiceProfileMissingError {
  const detail =
    reason === "dir-missing"
      ? `voice_profile/ directory not found at ${voiceDir}`
      : reason === "file-empty"
        ? `${REQUIRED_VOICE_FILE} exists but is empty`
        : `${REQUIRED_VOICE_FILE} not found in ${voiceDir}`;
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
 * present and non-empty. Called at server startup (for the local tenant) so we
 * fail loudly rather than silently degrading reply quality.
 */
export function validateVoiceProfile(tenantId: string = DEFAULT_TENANT): void {
  const voiceDir = voiceDirFor(tenantId);
  if (!existsSync(voiceDir)) throw buildMissingError(voiceDir, "dir-missing");
  const path = join(voiceDir, REQUIRED_VOICE_FILE);
  if (!existsSync(path)) throw buildMissingError(voiceDir, "file-missing");
  const body = readFileSync(path, "utf-8").trim();
  if (!body) throw buildMissingError(voiceDir, "file-empty");
}

/**
 * Read the compiled voice profile for a tenant. Returns its body. Assumes
 * validateVoiceProfile() has already been called at boot for the local tenant —
 * if the file vanishes between boot and an /analyze call (rare), or a hosted
 * tenant has no profile yet, this falls back to a marker string rather than
 * crashing the request.
 */
export function loadVoiceProfile(tenantId: string = DEFAULT_TENANT): string {
  const path = join(voiceDirFor(tenantId), REQUIRED_VOICE_FILE);
  if (!existsSync(path)) return "(voice profile missing — restart backend)";
  const body = readFileSync(path, "utf-8").trim();
  return body || "(voice profile is empty)";
}

/** Absolute path to a tenant's compiled voice profile (for stat/mtime in the console). */
export function voiceProfilePath(tenantId: string = DEFAULT_TENANT): string {
  return join(voiceDirFor(tenantId), REQUIRED_VOICE_FILE);
}
