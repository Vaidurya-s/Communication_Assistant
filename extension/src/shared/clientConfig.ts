// Backend connection settings (H3): which backend origin to talk to and an
// optional bearer token for hosted/enforced-auth deployments. Stored in
// chrome.storage.sync so it follows the user across machines. Defaults to the
// local backend with no token, so a fresh install works against localhost with
// zero configuration.

const KEY = "backend";
export const DEFAULT_ORIGIN = "http://localhost:8000";

export interface BackendSettings {
  /** Origin only, no trailing slash, e.g. "http://localhost:8000". */
  origin: string;
  /** Bearer token; empty in local mode. */
  token: string;
}

function normaliseOrigin(raw: unknown): string {
  const s = (raw ?? "").toString().trim().replace(/\/+$/, "");
  return s || DEFAULT_ORIGIN;
}

export async function getBackendSettings(): Promise<BackendSettings> {
  const all = await chrome.storage.sync.get(KEY);
  const v = (all[KEY] ?? {}) as Partial<BackendSettings>;
  return {
    origin: normaliseOrigin(v.origin),
    token: (v.token ?? "").toString().trim(),
  };
}

export async function setBackendSettings(s: BackendSettings): Promise<void> {
  await chrome.storage.sync.set({
    [KEY]: { origin: normaliseOrigin(s.origin), token: s.token.trim() },
  });
}

/** The host-permission match pattern for an origin (for chrome.permissions). */
export function originMatchPattern(origin: string): string {
  return normaliseOrigin(origin) + "/*";
}

/** True for the built-in localhost origin (always covered by manifest perms). */
export function isDefaultOrigin(origin: string): boolean {
  return normaliseOrigin(origin) === DEFAULT_ORIGIN;
}
