export type Mode = "suggest" | "continue_draft" | "shorter" | "longer" | "follow_up";

interface IncomingMessage {
  sender: string;
  isSelf: boolean;
  timestamp?: string;
  text: string;
}

interface IncomingContext {
  platform?: string;
  conversation_title?: string;
  participants?: Array<{ name: string; role?: string }>;
  messages?: IncomingMessage[];
  current_draft?: string;
}

export interface BuildPromptInput {
  ctx: IncomingContext;
  voiceProfile: string;
  mode: Mode;
  seedText?: string;
  existingNotes?: string[]; // memory bullets to inject; empty/undefined → section omitted
}

const MAX_MESSAGES = 30;

const BASE_RULES =
  "Reply with ONLY the message text — no preamble, no quotes, no labels, no commentary about your process.";

function instructionFor(mode: Mode, seed: string, draft: string): string {
  switch (mode) {
    case "suggest":
      return `Suggest ONE reply that sounds exactly like the VOICE PROFILE and fits the conversation. ${BASE_RULES}`;
    case "continue_draft":
      return `Continue or rewrite my draft so it sounds exactly like the VOICE PROFILE and fits this conversation. My draft: ${JSON.stringify(draft)}. ${BASE_RULES}`;
    case "shorter":
      return `Rewrite the following message to be noticeably shorter while keeping the meaning and the VOICE PROFILE style. Message: ${JSON.stringify(seed)}. ${BASE_RULES}`;
    case "longer":
      return (
        `Rewrite the following message to be NOTICEABLY LONGER (roughly 2x), expanding with substance — not filler. ` +
        `BEFORE drafting, USE your Read/Grep tools on linkedin_successful_messages.md in your workspace to find 1-2 of my real past messages of similar length and topic. Absorb their rhythm: how I open, transition, qualify, and close longer messages. Do NOT copy verbatim. ` +
        `Stay grounded in the VOICE PROFILE for tone. ` +
        `Message to extend: ${JSON.stringify(seed)}. ${BASE_RULES}`
      );
    case "follow_up":
      return `Compose ONE short follow-up question I could send to keep this conversation alive. Match the VOICE PROFILE. Don't summarize what was already said. ${BASE_RULES}`;
  }
}

// Auto-fallback: if a rewrite mode came in without seed text, treat as suggest.
function resolveMode(mode: Mode, seedText: string, draft: string): Mode {
  if ((mode === "shorter" || mode === "longer") && !seedText.trim()) return "suggest";
  if (mode === "suggest" && draft.trim()) return "continue_draft";
  return mode;
}

export function buildPrompt(input: BuildPromptInput): { instruction: string; context: string; resolvedMode: Mode; transcript: string } {
  const { ctx, voiceProfile, seedText, existingNotes } = input;
  const messages = (ctx.messages ?? []).slice(-MAX_MESSAGES);

  const transcript = messages
    .map((m) => {
      const who = m.isSelf ? "ME" : m.sender || "THEM";
      const ts = m.timestamp ? ` [${m.timestamp}]` : "";
      return `${who}${ts}: ${m.text}`;
    })
    .join("\n");

  const draft = (ctx.current_draft ?? "").trim();
  const seed = (seedText ?? "").trim();
  const title = ctx.conversation_title ?? "(unknown thread)";
  const platform = ctx.platform ?? "unknown";

  const resolvedMode = resolveMode(input.mode, seed, draft);

  const memorySection = existingNotes && existingNotes.length > 0
    ? [
        "",
        "=== WHAT I ALREADY KNOW ABOUT THIS PERSON ===",
        ...existingNotes.map((n) => `- ${n}`),
      ]
    : [];

  const context = [
    "=== VOICE PROFILE (how I write — match this voice) ===",
    voiceProfile,
    ...memorySection,
    "",
    "=== AVAILABLE FILES IN YOUR WORKSPACE ===",
    "linkedin_successful_messages.md — a corpus of my real past LinkedIn messages.",
    "Use your Grep/Read tools on this file IF you want to see how I phrased",
    "something specific (e.g. a similar topic, person, technical area, or",
    "opening line). Search before drafting if the conversation references a",
    "domain you haven't seen examples of in the VOICE PROFILE. Otherwise the",
    "VOICE PROFILE alone is sufficient — don't grep unless it actually helps.",
    "",
    "=== CONVERSATION CONTEXT ===",
    `Platform: ${platform}`,
    `Thread: ${title}`,
    "",
    "Recent messages (oldest first):",
    transcript || "(no messages extracted)",
    "",
    draft ? `My draft so far: ${draft}` : "My draft so far: (empty)",
  ].join("\n");

  const instruction = instructionFor(resolvedMode, seed, draft);

  return { instruction, context, resolvedMode, transcript };
}
