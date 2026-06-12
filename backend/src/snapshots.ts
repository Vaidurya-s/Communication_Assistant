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

function snapshotDir(tenantId: string): string {
  // Sanitise — tenantId can come from a request header; never let it escape the dir.
  const safe = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_") || "local";
  return resolve(process.cwd(), "data", "snapshots", safe);
}

function ensureDir(tenantId: string): string {
  const dir = snapshotDir(tenantId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
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

export function saveSnapshot(tenantId: string, payload: unknown): SaveResult {
  const dir = ensureDir(tenantId);
  const capturedAt =
    typeof payload === "object" && payload !== null && "capturedAt" in payload
      ? (payload as { capturedAt?: unknown }).capturedAt
      : undefined;
  const { id, filename } = filenameFor(typeof capturedAt === "string" ? capturedAt : undefined);
  const path = join(dir, filename);
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

function readIndexEntry(dir: string, filename: string): SnapshotIndexEntry | null {
  const path = join(dir, filename);
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

export function listSnapshots(tenantId: string): SnapshotIndexEntry[] {
  const dir = snapshotDir(tenantId);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
    .map((f) => readIndexEntry(dir, f))
    .filter((e): e is SnapshotIndexEntry => e !== null);
  // Newest first.
  entries.sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1));
  return entries;
}

export function getSnapshotDir(tenantId: string): string {
  return snapshotDir(tenantId);
}
