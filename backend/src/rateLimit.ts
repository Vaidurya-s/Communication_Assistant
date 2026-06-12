/**
 * Per-tenant rate limiting (H5). A simple in-memory sliding-window counter,
 * keyed by tenant, applied to the expensive LLM route. In-process state is fine
 * for a single-node deployment; a multi-node hosted setup would swap this for a
 * shared store (Redis), keeping the same checkRate() contract.
 *
 * Disabled by default (limitPerMin <= 0) so local installs are unthrottled.
 */
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

export interface RateDecision {
  ok: boolean;
  /** Seconds until the caller may retry (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Record-and-check one request for a tenant against a per-minute limit. `now`
 * is injectable for tests. When the limit is hit the request is NOT counted, so
 * a blocked caller doesn't push its own retry window further out.
 */
export function checkRate(
  tenantId: string,
  limitPerMin: number,
  now: number = Date.now(),
): RateDecision {
  if (limitPerMin <= 0) return { ok: true, retryAfterSec: 0 };

  const cutoff = now - WINDOW_MS;
  const recent = (hits.get(tenantId) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limitPerMin) {
    hits.set(tenantId, recent);
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfterSec };
  }

  recent.push(now);
  hits.set(tenantId, recent);
  return { ok: true, retryAfterSec: 0 };
}

/** Test seam: clear all windows. */
export function resetRateLimits(): void {
  hits.clear();
}
