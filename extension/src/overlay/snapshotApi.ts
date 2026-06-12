import type { Snapshot } from "../content/snapshot";
import { backendFetch } from "../shared/backend";

export type SnapshotExportResult =
  | { kind: "saved"; filename: string; bytes: number }
  | { kind: "clipboard" }
  | { kind: "failed"; reason: string };

interface SaveResponse {
  id: string;
  filename: string;
  bytes: number;
}

/**
 * Try to POST the snapshot to the backend. On any failure (offline, 5xx,
 * malformed response) fall back to the clipboard so the user never loses
 * a forensic capture. Returns which path succeeded.
 */
export async function exportSnapshot(snap: Snapshot): Promise<SnapshotExportResult> {
  const json = JSON.stringify(snap, null, 2);

  try {
    const res = await backendFetch(`/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const j = (await res.json()) as SaveResponse;
      if (j?.filename) return { kind: "saved", filename: j.filename, bytes: j.bytes };
    }
  } catch {
    // fall through to clipboard
  }

  // Backend unreachable or rejected — preserve the snapshot on the clipboard.
  try {
    await navigator.clipboard.writeText(json);
    return { kind: "clipboard" };
  } catch (err) {
    return { kind: "failed", reason: (err as Error).message };
  }
}
