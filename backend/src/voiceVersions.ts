/**
 * Voice profile versioning.
 *
 * Regenerate / distill / compile / apply-corrections all OVERWRITE the runtime
 * strategy_analysis.md. That's the right model (one canonical artifact) but it's
 * destructive — a regeneration that fixes one thing can quietly break another,
 * and today there's no undo. So before any mutating op we snapshot the current
 * compiled profile under voice_profile/versions/, and expose list + restore.
 *
 * Deterministic, no LLM. Snapshots live beside the profile (gitignored for the
 * local tenant) and are pruned to the most recent N.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_TENANT } from "./tenant.js";
import { voiceDirFor, voiceProfilePath } from "./voiceProfile.js";

const KEEP = 20;
const SAFE_REASON = /[^a-z0-9-]+/gi;
// Filenames we mint: v_<iso-with-:.-replaced>__<reason>.md
const ID_RE = /^v_[0-9a-z-]+__[a-z0-9-]+\.md$/i;

function versionsDir(tenantId: string): string {
  return join(voiceDirFor(tenantId), "versions");
}

export interface ProfileVersion {
  id: string; // the snapshot filename (also the restore handle)
  reason: string; // what triggered it (compile / distill / apply / pre-restore …)
  created_at: string; // file mtime, ISO
  chars: number;
}

/**
 * Snapshot the current compiled profile before a mutating op. Returns the new
 * version id, or null if there's nothing (no profile yet, or it's empty) to save.
 */
export function snapshotProfile(
  tenantId: string = DEFAULT_TENANT,
  reason = "edit",
  nowIso?: string,
): string | null {
  const src = voiceProfilePath(tenantId);
  if (!existsSync(src)) return null;
  const content = readFileSync(src, "utf-8");
  if (!content.trim()) return null;

  const dir = versionsDir(tenantId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const safeReason =
    reason.replace(SAFE_REASON, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "edit";
  // ':' and '.' are invalid in Windows filenames — flatten them.
  const tsSafe = (nowIso ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const id = `v_${tsSafe}__${safeReason}.md`;
  writeFileSync(join(dir, id), content, "utf-8");
  pruneVersions(tenantId);
  return id;
}

/** Versions, newest first. */
export function listVersions(tenantId: string = DEFAULT_TENANT): ProfileVersion[] {
  const dir = versionsDir(tenantId);
  if (!existsSync(dir)) return [];
  const out: ProfileVersion[] = [];
  for (const name of readdirSync(dir)) {
    if (!ID_RE.test(name)) continue;
    let st;
    try {
      st = statSync(join(dir, name));
    } catch {
      continue;
    }
    out.push({
      id: name,
      reason: name.slice(0, -3).split("__")[1] ?? "edit",
      created_at: st.mtime.toISOString(),
      chars: st.size,
    });
  }
  // Filename timestamps sort chronologically; tie-break is irrelevant.
  out.sort((a, b) => (a.id < b.id ? 1 : -1));
  return out;
}

/** Guard against path traversal — id must be a plain filename we produced. */
function isValidId(id: string): boolean {
  return ID_RE.test(id) && !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

/**
 * Restore a snapshot as the runtime profile. Caller should snapshot the CURRENT
 * profile first (reason "pre-restore") so the restore is itself undoable, and
 * bust the voice cache after. Returns false on a bad/missing id.
 */
export function restoreVersion(tenantId: string = DEFAULT_TENANT, id: string): boolean {
  if (!isValidId(id)) return false;
  const file = join(versionsDir(tenantId), id);
  if (!existsSync(file)) return false;
  writeFileSync(voiceProfilePath(tenantId), readFileSync(file, "utf-8"), "utf-8");
  return true;
}

/** Keep only the most recent `keep` snapshots. */
export function pruneVersions(tenantId: string = DEFAULT_TENANT, keep = KEEP): void {
  const dir = versionsDir(tenantId);
  for (const v of listVersions(tenantId).slice(keep)) {
    try {
      rmSync(join(dir, v.id));
    } catch {
      /* ignore */
    }
  }
}
