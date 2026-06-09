import type { ExtractionDiagnostics } from "../content/diagnostics";

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
}

/** What `extractLinkedInContext` returns — context + the diagnostics of how it was produced. */
export interface ExtractionResult {
  context: ConversationContext;
  diagnostics: ExtractionDiagnostics;
}
