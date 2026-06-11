import { describe, it, expect } from "vitest";
import { buildPrompt, type BuildPromptInput } from "./prompt.js";

function base(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
  return {
    ctx: {
      conversation_title: "Maya Chen",
      messages: [
        { sender: "Maya Chen", isSelf: false, text: "Hi there!" },
        { sender: "Me", isSelf: true, text: "Hey Maya" },
      ],
      current_draft: "",
    },
    voiceProfile: "I write warmly and concisely.",
    mode: "suggest",
    ...overrides,
  };
}

describe("buildPrompt", () => {
  it("resolves suggest -> continue_draft when a draft is present", () => {
    const r = buildPrompt(base({ ctx: { ...base().ctx, current_draft: "Thanks for" } }));
    expect(r.resolvedMode).toBe("continue_draft");
  });

  it("falls back shorter/longer -> suggest when seedText is empty", () => {
    expect(buildPrompt(base({ mode: "shorter", seedText: "" })).resolvedMode).toBe("suggest");
    expect(buildPrompt(base({ mode: "longer" })).resolvedMode).toBe("suggest");
  });

  it("keeps shorter when seedText is provided", () => {
    expect(buildPrompt(base({ mode: "shorter", seedText: "make this short" })).resolvedMode).toBe("shorter");
  });

  it("fences the conversation in an UNTRUSTED_CONVERSATION block", () => {
    const r = buildPrompt(base());
    expect(r.context).toContain("<UNTRUSTED_CONVERSATION>");
    expect(r.context).toContain("</UNTRUSTED_CONVERSATION>");
    expect(r.context).toContain("Maya Chen"); // thread title inside the payload
  });

  it("injects the voice profile and confirmed notes (trusted, outside the fence)", () => {
    const r = buildPrompt(base({ existingNotes: ["Prefers async updates"] }));
    expect(r.context).toContain("VOICE PROFILE");
    expect(r.context).toContain("I write warmly and concisely.");
    expect(r.context).toContain("WHAT I ALREADY KNOW ABOUT THIS PERSON");
    expect(r.context).toContain("- Prefers async updates");
  });

  it("omits the memory section when there are no notes", () => {
    expect(buildPrompt(base()).context).not.toContain("WHAT I ALREADY KNOW");
  });

  it("appends the user's steer as a trusted directive on the instruction", () => {
    const r = buildPrompt(base({ steer: "make it warmer" }));
    expect(r.instruction).toContain("ADDITIONAL INSTRUCTION FROM ME");
    expect(r.instruction).toContain("make it warmer");
  });

  it("builds a ME/THEM transcript capped at 30 messages", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      sender: "Maya Chen",
      isSelf: i % 2 === 0,
      text: `m${i}`,
    }));
    const r = buildPrompt(base({ ctx: { ...base().ctx, messages: many } }));
    expect(r.transcript.split("\n")).toHaveLength(30);
    expect(r.transcript).toContain("ME: ");
    expect(r.transcript).toContain("Maya Chen: ");
  });
});
