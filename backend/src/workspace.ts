/**
 * Gemini workspace sandbox.
 *
 * Gemini runs with --approval-mode plan and has read-only Grep/Read tools. Its
 * cwd is whatever we set. The risk is: if cwd contains files we don't want
 * gemini to read (config, secrets, sibling project code, the voice profile
 * itself), a malicious message could ask gemini to grep them.
 *
 * Defense: gemini's cwd is a dedicated, isolated, PER-TENANT directory that
 * contains ONLY the explicitly-allowlisted files for that tenant. We copy them
 * in on demand. Voice profile loading still happens from the tenant's
 * voice_profile/ directly (server-side, not via gemini's tools).
 *
 * Long-term target: remove gemini's filesystem tools entirely and do
 * server-side retrieval (top-K relevant excerpts) before prompting. This
 * module is the staging step toward that.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_TENANT, safeTenant } from "./tenant.js";
import { voiceDirFor } from "./voiceProfile.js";

/** Files we ARE willing for gemini to grep/read on demand, per tenant. */
function allowlistFor(tenantId: string): ReadonlyArray<{ from: string; to: string }> {
  return [
    {
      from: join(voiceDirFor(tenantId), "linkedin_successful_messages.md"),
      to: "linkedin_successful_messages.md",
    },
  ];
}

/**
 * The gemini sandbox cwd for a tenant. The local tenant keeps the original
 * backend/data/gemini_workspace path; other tenants are isolated under
 * backend/data/tenants/<id>/gemini_workspace.
 */
function sandboxDirFor(tenantId: string = DEFAULT_TENANT): string {
  if (tenantId === DEFAULT_TENANT) return resolve(process.cwd(), "data", "gemini_workspace");
  return resolve(process.cwd(), "data", "tenants", safeTenant(tenantId), "gemini_workspace");
}

// Per-tenant one-time log guard (avoids spamming the console on every request).
const logged = new Set<string>();

/**
 * Idempotent. Creates the tenant's sandbox dir if needed, copies all
 * allowlisted files into it (overwriting), and removes any stray files that
 * aren't on the list. Returns the absolute path to use as gemini's cwd.
 */
export function ensureWorkspace(tenantId: string = DEFAULT_TENANT): string {
  const sandboxDir = sandboxDirFor(tenantId);
  if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true });

  // Copy allowlisted files in (overwrite — voice profile updates land on restart).
  const expected = new Set<string>();
  for (const item of allowlistFor(tenantId)) {
    if (!existsSync(item.from)) {
      if (!logged.has(tenantId)) {
        console.warn(`[workspace] allowlisted source missing, skipping: ${item.from}`);
      }
      continue;
    }
    copyFileSync(item.from, join(sandboxDir, item.to));
    expected.add(item.to);
  }

  // Sweep: remove any files in the sandbox that aren't on the allowlist.
  // Protects against an old/renamed corpus lingering from a prior run.
  for (const entry of readdirSync(sandboxDir)) {
    if (!expected.has(entry)) {
      try {
        unlinkSync(join(sandboxDir, entry));
      } catch (err) {
        console.warn(`[workspace] failed to remove stray file ${entry}:`, (err as Error).message);
      }
    }
  }

  if (!logged.has(tenantId)) {
    console.log(`[workspace] gemini sandbox for '${tenantId}' at ${sandboxDir} (${expected.size} files)`);
    logged.add(tenantId);
  }
  return sandboxDir;
}

export function getWorkspacePath(tenantId: string = DEFAULT_TENANT): string {
  return sandboxDirFor(tenantId);
}
