import { runGemini } from "./gemini.js";
import type { Note } from "./memory.js";

export interface InsightResult {
  memory_proposal: { contact_name: string; note: string } | null;
  strategy: { text: string; suggested_followup_at: string | null } | null;
}

interface InsightInput {
  contactName: string;
  transcript: string;
  existingNotes: Note[];
  todayIso: string; // helps gemini compute followup dates relative to "now"
}

const INSTRUCTION =
  "Respond with EXACTLY three lines in this format and NOTHING else:\n" +
  "MEMORY: <one short fact worth remembering about the contact, or NONE>\n" +
  "STRATEGY: <one short strategic read on this conversation, or NONE>\n" +
  "FOLLOWUP_AT: <YYYY-MM-DD if strategy implies a timeframe (e.g. 'in 3 days', 'next week'), or NONE>";

export async function generateInsight(input: InsightInput): Promise<InsightResult> {
  const existingNotesBlock = input.existingNotes.length > 0
    ? input.existingNotes.map((n) => `- ${n.body}`).join("\n")
    : "(none)";

  const context = [
    "You are reviewing a LinkedIn conversation to surface (a) a remember-worthy fact and (b) a strategic read.",
    "Be terse. Do NOT use any tools — answer only from the text below.",
    "",
    `Today is ${input.todayIso}.`,
    `Contact: ${input.contactName || "(unknown)"}`,
    "",
    "=== EXISTING NOTES ABOUT THIS CONTACT ===",
    existingNotesBlock,
    "",
    "=== CONVERSATION TRANSCRIPT ===",
    input.transcript || "(empty)",
  ].join("\n");

  try {
    const result = await runGemini(INSTRUCTION, context);
    return parseInsight(result.text, input.contactName);
  } catch (err) {
    console.warn("[insight] gemini failed (returning empty):", (err as Error).message);
    return { memory_proposal: null, strategy: null };
  }
}

export function parseInsight(raw: string, contactName: string): InsightResult {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const get = (prefix: string): string | null => {
    const line = lines.find((l) => l.toUpperCase().startsWith(prefix));
    if (!line) return null;
    const value = line.slice(prefix.length).trim();
    if (!value || value.toUpperCase() === "NONE") return null;
    return value;
  };

  const memoryText = get("MEMORY:");
  const strategyText = get("STRATEGY:");
  const followupRaw = get("FOLLOWUP_AT:");

  const followupIso = followupRaw ? normalizeFollowupDate(followupRaw) : null;

  return {
    memory_proposal:
      memoryText && contactName ? { contact_name: contactName, note: memoryText } : null,
    strategy: strategyText
      ? { text: strategyText, suggested_followup_at: followupIso }
      : null,
  };
}

// Accept YYYY-MM-DD or a full ISO date. Reject anything else.
function normalizeFollowupDate(s: string): string | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
