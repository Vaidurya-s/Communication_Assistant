import type { ConversationContext } from "./types";
import type { ExtractionDiagnostics } from "../content/diagnostics";
import type { ContactProfile } from "./profile";

export type Mode = "suggest" | "continue_draft" | "shorter" | "longer" | "follow_up" | "cold_open";

export interface AnalyzeRequest {
  type: "ANALYZE_REQUEST";
  mode: Mode;
  seed_text?: string;
  /**
   * Free-form steering instruction typed by the user in the overlay
   * ("make it warmer", "mention the demo", "decline politely"). Trusted —
   * it's the user's own instruction, applied OUTSIDE the untrusted boundary.
   */
  steer?: string;
}

export interface BackendResponse {
  suggested_reply: string;
  // memory_proposal and strategy are populated by Phase 3+4; null in Phase 2.
  memory_proposal: { contact_name: string; note: string } | null;
  strategy: { text: string; suggested_followup_at: string | null } | null;
  stats?: Record<string, unknown>;
}

export type RuntimeMessage =
  | AnalyzeRequest
  | { type: "EXTRACT_REQUEST"; backfill: boolean }
  | {
      type: "CONTEXT_EXTRACTED";
      payload: ConversationContext;
      diagnostics: ExtractionDiagnostics;
      trigger: "user" | "observer";
      anomalySnapshotArmed?: boolean;
    }
  | { type: "BACKEND_RESPONSE"; payload: BackendResponse }
  | { type: "STATUS_REQUEST" }
  | {
      type: "STATUS_RESPONSE";
      lastContext: ConversationContext | null;
      lastDiagnostics: ExtractionDiagnostics | null;
      lastResponse: BackendResponse | null;
    }
  /** Background → content script (on a profile page): build a cold-open context. */
  | { type: "COLD_OPEN_CONTEXT_REQUEST" }
  /** Content script → background: synthetic context for a first message (no history). */
  | { type: "COLD_OPEN_CONTEXT"; payload: ConversationContext | null }
  /** Content script (on a thread) → background: kick off profile fetch for this URL. */
  | { type: "PROFILE_FETCH_REQUEST"; profileUrl: string }
  /** Content script (on a profile page) → background: extracted payload. */
  | { type: "PROFILE_EXTRACTED"; payload: ContactProfile }
  /** Popup → background: ensure the content script is injected and mount the overlay. */
  | { type: "OPEN_OVERLAY" }
  /**
   * Popup → background: draft a first message to a contact by profile URL,
   * from anywhere. Background fetches the profile (hidden tab) and runs a
   * cold_open analyze; the reply comes back as BACKEND_RESPONSE.
   */
  | { type: "COMPOSE_INTRO"; profileUrl: string; intent: string }
  /**
   * Popup → background: scrape the user's OWN profile (the active profile tab)
   * and import it into the backend's personal-context ("About me") store as
   * proposed items for later confirmation.
   */
  | { type: "IMPORT_SELF_PROFILE" }
  /** Background → popup: profile imported; `created` proposed context items. */
  | { type: "IMPORT_RESULT"; payload: { created: number } }
  /** Background → content script: (re-)mount the overlay on demand. */
  | { type: "SHOW_OVERLAY" }
  /** Content script → caller: the overlay is now mounted. */
  | { type: "OVERLAY_OPENED" }
  | { type: "ERROR"; message: string };
