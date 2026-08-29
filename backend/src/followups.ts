/**
 * Which follow-ups are actually due.
 *
 * The data has been here all along — `contacts.suggested_followup_at`, written
 * by the insight pass, surfaced in the dashboard's Follow-ups tab and the
 * calendar export. What was missing is anything that NOTICES when a date
 * arrives: the extension had no alarm and no badge, so a follow-up only ever
 * reached you if you remembered to go and look, which is the one thing tracking
 * it was supposed to fix.
 *
 * Pure on purpose — no db, no clock of its own — so the due/overdue boundary is
 * unit-testable and the caller supplies "now".
 */

/** The structural subset of a contact this module needs. */
export interface FollowupCandidate {
  name: string;
  suggested_followup_at: string | null;
  last_thread_url: string | null;
}

export interface DueFollowup {
  name: string;
  /** The stored date, normalised to YYYY-MM-DD. */
  due_on: string;
  /** Whole days late; 0 means it's due today. */
  days_overdue: number;
  /** Deep link back into the thread, when we recorded one. */
  thread_url: string | null;
}

/** Calendar day of an ISO date or datetime. Returns "" for anything unusable. */
function dayOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const day = iso.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to`, both calendar days. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Follow-ups due on or before `nowIso`, most overdue first.
 *
 * Comparison is by CALENDAR DAY, not timestamp: a follow-up dated today is due
 * all day, not from midnight-plus-one-second. Stored values are `YYYY-MM-DD`
 * from the insight pass, but full ISO datetimes are accepted too, since
 * `setFollowupAt` will store whatever it's handed. Anything unparseable is
 * skipped rather than treated as due — a malformed date must not nag forever.
 */
export function dueFollowups(
  contacts: FollowupCandidate[],
  nowIso: string,
): DueFollowup[] {
  const today = dayOf(nowIso);
  if (!today) return [];

  const out: DueFollowup[] = [];
  for (const c of contacts) {
    const due = dayOf(c.suggested_followup_at);
    if (!due || due > today) continue;
    out.push({
      name: c.name,
      due_on: due,
      days_overdue: daysBetween(due, today),
      thread_url: c.last_thread_url,
    });
  }
  return out.sort((a, b) => b.days_overdue - a.days_overdue || a.name.localeCompare(b.name));
}
