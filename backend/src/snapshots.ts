/**
 * Versioned snapshot store.
 *
 * Snapshots are forensic captures of LinkedIn DOM + parsed context at the
 * moment something looked off (anomaly auto-arm) or the user explicitly
 * captured one. We persist them to backend/data/snapshots/ so they can be
 * grepped, diffed, and used to update selectors.ts against real DOM.
 *
 * Contents are sensitive (page title, conversation contents, viewport).
 * backend/data/ is gitignored.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const SNAPSHOT_DIR = resolve(process.cwd(), "data", "snapshots");

function ensureDir(): string {
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
  return SNAPSHOT_DIR;
}

function filenameFor(capturedAt: string | undefined): { id: string; filename: string } {
  const ts = capturedAt && !Number.isNaN(Date.parse(capturedAt))
    ? new Date(capturedAt)
    : new Date();
  const stamp = ts.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const shortId = randomBytes(4).toString("hex");
  const id = `${stamp}-${shortId}`;
  return { id, filename: `snapshot-${id}.json` };
}

export interface SaveResult {
  id: string;
  filename: string;
  path: string;
  bytes: number;
}

export function saveSnapshot(payload: unknown): SaveResult {
  ensureDir();
  const capturedAt =
    typeof payload === "object" && payload !== null && "capturedAt" in payload
      ? (payload as { capturedAt?: unknown }).capturedAt
      : undefined;
  const { id, filename } = filenameFor(typeof capturedAt === "string" ? capturedAt : undefined);
  const path = join(SNAPSHOT_DIR, filename);
  const enriched = {
    id,
    savedAt: new Date().toISOString(),
    ...((typeof payload === "object" && payload !== null) ? (payload as Record<string, unknown>) : { raw: payload }),
  };
  const body = JSON.stringify(enriched, null, 2);
  writeFileSync(path, body, "utf-8");
  return { id, filename, path, bytes: Buffer.byteLength(body, "utf-8") };
}

export interface SnapshotIndexEntry {
  id: string;
  filename: string;
  bytes: number;
  capturedAt: string | null;
  savedAt: string;
  url: string | null;
  pageTitle: string | null;
  messagesFound: number | null;
  anomalies: string[];
}

function readIndexEntry(filename: string): SnapshotIndexEntry | null {
  const path = join(SNAPSHOT_DIR, filename);
  try {
    const stat = statSync(path);
    const raw = readFileSync(path, "utf-8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const diagnostics = (obj.diagnostics ?? null) as { anomalies?: string[]; messagesFound?: number } | null;
    return {
      id: typeof obj.id === "string" ? obj.id : filename.replace(/^snapshot-|\.json$/g, ""),
      filename,
      bytes: stat.size,
      capturedAt: typeof obj.capturedAt === "string" ? obj.capturedAt : null,
      savedAt: typeof obj.savedAt === "string" ? obj.savedAt : stat.mtime.toISOString(),
      url: typeof obj.url === "string" ? obj.url : null,
      pageTitle: typeof obj.pageTitle === "string" ? obj.pageTitle : null,
      messagesFound: typeof diagnostics?.messagesFound === "number" ? diagnostics.messagesFound : null,
      anomalies: Array.isArray(diagnostics?.anomalies) ? diagnostics.anomalies : [],
    };
  } catch {
    return null;
  }
}

export function listSnapshots(): SnapshotIndexEntry[] {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  const entries = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
    .map(readIndexEntry)
    .filter((e): e is SnapshotIndexEntry => e !== null);
  // Newest first.
  entries.sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1));
  return entries;
}

export function getSnapshotDir(): string {
  return SNAPSHOT_DIR;
}
