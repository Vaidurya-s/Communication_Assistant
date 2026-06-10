import type { ConversationContext } from "./types";
import type { ExtractionDiagnostics } from "../content/diagnostics";
import type { ContactProfile } from "./profile";

export type Mode = "suggest" | "continue_draft" | "shorter" | "longer" | "follow_up";

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
  /** Content script (on a thread) → background: kick off profile fetch for this URL. */
  | { type: "PROFILE_FETCH_REQUEST"; profileUrl: string }
  /** Content script (on a profile page) → background: extracted payload. */
  | { type: "PROFILE_EXTRACTED"; payload: ContactProfile }
  | { type: "ERROR"; message: string };

export const BACKEND_URL = "http://localhost:8000/analyze";
