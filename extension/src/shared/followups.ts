/**
 * Follow-up badge helpers.
 *
 * Kept out of `background/index.ts` on purpose: that file is a service-worker
 * entry with `chrome.*` at module scope, so anything defined in it can't be
 * unit-tested without mocking the whole extension API (which is why
 * `takePrefetch` has no tests today). The decisions worth testing live here.
 */

/** One due follow-up, as returned by the backend's /memory/followups. */
export interface DueFollowup {
  name: string;
  due_on: string;
  days_overdue: number;
  thread_url: string | null;
}

/**
 * Badge text for a due count. Empty string clears the badge.
 *
 * Capped at "9+": the badge is a few pixels wide, and a precise count past a
 * handful tells you nothing you'd act on differently.
 */
export function badgeTextFor(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9 ? "9+" : String(count);
}

/** Human phrasing for how late a follow-up is. */
export function describeDue(f: DueFollowup): string {
  if (f.days_overdue <= 0) return "due today";
  if (f.days_overdue === 1) return "1 day overdue";
  return `${f.days_overdue} days overdue`;
}

/** Parse a /memory/followups response defensively — the backend may be any version. */
export function parseFollowups(body: unknown): DueFollowup[] {
  const list = (body as { followups?: unknown })?.followups;
  if (!Array.isArray(list)) return [];
  return list
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      name: typeof f.name === "string" ? f.name : "",
      due_on: typeof f.due_on === "string" ? f.due_on : "",
      days_overdue: typeof f.days_overdue === "number" ? f.days_overdue : 0,
      thread_url: typeof f.thread_url === "string" ? f.thread_url : null,
    }))
    .filter((f) => f.name);
}
