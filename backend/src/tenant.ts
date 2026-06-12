/**
 * Tenant resolution. Today everything is the single implicit "local" tenant;
 * the X-Comms-Tenant header is a forward seam for H2 (auth + real identity).
 * Absent/blank header → "local", so the dashboard and extension (which send no
 * tenant) keep working unchanged.
 */
export const DEFAULT_TENANT = "local";

/** Resolve the tenant id from a request's headers. */
export function tenantOf(req: { header(name: string): string | undefined }): string {
  return (req.header("x-comms-tenant") || "").trim() || DEFAULT_TENANT;
}

/**
 * Filesystem-safe form of a tenant id, for use as a path segment. The id can
 * originate from a request header, so anything outside [A-Za-z0-9_-] is
 * collapsed to "_" (defeats path traversal); an empty result falls back to the
 * default tenant.
 */
export function safeTenant(tenantId: string): string {
  return tenantId.replace(/[^a-zA-Z0-9_-]/g, "_") || DEFAULT_TENANT;
}
