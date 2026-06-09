import type { ExtractionDiagnostics } from "../content/diagnostics";
import type { ContactProfile } from "./profile";

export type Platform = "linkedin" | "whatsapp" | "gmail" | "unknown";

export interface Participant {
  name: string;
  role?: string;
}

export interface Message {
  sender: string;
  isSelf: boolean;
  timestamp?: string;
  text: string;
}

export interface PageMetadata {
  url: string;
  title: string;
  extracted_at: string;
}

export interface ConversationContext {
  platform: Platform;
  conversation_title: string;
  participants: Participant[];
  messages: Message[];
  current_draft: string;
  page_metadata: PageMetadata;
  /**
   * URL of the other participant's profile, when discoverable from the thread
   * header. Used by the background to fetch profile enrichment in a hidden tab.
   * Same string is sent to the backend so it can correlate cached profile data.
   */
  contact_profile_url?: string | null;
  /**
   * Enriched profile data from the contact's LinkedIn profile page. Populated
   * by the background script (out-of-band fetch) before /analyze is called.
   * Every field is attacker-controlled; backend treats it as UNTRUSTED.
   */
  contact_profile?: ContactProfile | null;
}

/** What `extractLinkedInContext` returns — context + the diagnostics of how it was produced. */
export interface ExtractionResult {
  context: ConversationContext;
  diagnostics: ExtractionDiagnostics;
}
