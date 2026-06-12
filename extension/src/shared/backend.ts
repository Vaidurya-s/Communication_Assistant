// Single entry point for every backend HTTP call from the extension (content
// script, overlay, and background service worker). Resolves the configured
// origin + token (H3) and attaches `Authorization: Bearer <token>` when set, so
// the same code works against a local backend (no token) or a hosted,
// enforced-auth backend (token required).

import { getBackendSettings } from "./clientConfig";

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { origin, token } = await getBackendSettings();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${origin}${path}`, { ...init, headers });
}

/** The configured backend origin (e.g. for display in the overlay). */
export async function getBackendOrigin(): Promise<string> {
  return (await getBackendSettings()).origin;
}
