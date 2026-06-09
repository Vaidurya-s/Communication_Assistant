/**
 * Gemini workspace sandbox.
 *
 * Gemini runs with --approval-mode plan and has read-only Grep/Read tools. Its
 * cwd is whatever we set. The risk is: if cwd contains files we don't want
 * gemini to read (config, secrets, sibling project code, the voice profile
 * itself), a malicious LinkedIn message could ask gemini to grep them.
 *
 * Defense: gemini's cwd is a dedicated, isolated directory that contains ONLY
 * the explicitly-allowlisted files. We copy them in at backend startup. Voice
 * profile loading still happens from voice_profile/ directly (server-side, not
 * via gemini's tools).
 *
 * Long-term target: remove gemini's filesystem tools entirely and do
 * server-side retrieval (top-K relevant excerpts) before prompting. This
 * module is the staging step toward that.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

/** Files we ARE willing for gemini to grep/read on demand. */
const ALLOWLIST: ReadonlyArray<{ from: string; to: string }> = [
  {
    from: resolve(process.cwd(), "..", "voice_profile", "linkedin_successful_messages.md"),
    to: "linkedin_successful_messages.md",
  },
];

const SANDBOX_DIR = resolve(process.cwd(), "data", "gemini_workspace");

let initialized = false;

/**
 * Idempotent. Creates the sandbox dir if needed, copies all allowlisted files
 * into it (overwriting), and removes any stray files that aren't on the list.
 * Returns the absolute path to use as gemini's cwd.
 */
export function ensureWorkspace(): string {
  if (!existsSync(SANDBOX_DIR)) mkdirSync(SANDBOX_DIR, { recursive: true });

  // Copy allowlisted files in (overwrite — voice profile updates land on restart).
  const expected = new Set<string>();
  for (const item of ALLOWLIST) {
    if (!existsSync(item.from)) {
      console.warn(`[workspace] allowlisted source missing, skipping: ${item.from}`);
      continue;
    }
    copyFileSync(item.from, join(SANDBOX_DIR, item.to));
    expected.add(item.to);
  }

  // Sweep: remove any files in the sandbox that aren't on the allowlist.
  // Protects against an old/renamed corpus lingering from a prior run.
  for (const entry of readdirSync(SANDBOX_DIR)) {
    if (!expected.has(entry)) {
      try {
        unlinkSync(join(SANDBOX_DIR, entry));
      } catch (err) {
        console.warn(`[workspace] failed to remove stray file ${entry}:`, (err as Error).message);
      }
    }
  }

  if (!initialized) {
    console.log(`[workspace] gemini sandbox at ${SANDBOX_DIR} (${expected.size} files)`);
    initialized = true;
  }
  return SANDBOX_DIR;
}

export function getWorkspacePath(): string {
  return SANDBOX_DIR;
}
