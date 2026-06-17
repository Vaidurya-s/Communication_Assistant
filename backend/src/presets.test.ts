import { describe, it, expect } from "vitest";
import { PRESETS, findPreset } from "./presets.js";

describe("presets", () => {
  it("finds a preset by id and misses gracefully", () => {
    expect(findPreset("openai")?.provider).toBe("openai-compat");
    expect(findPreset("gemini-cli")?.provider).toBe("gemini-cli");
    expect(findPreset("does-not-exist")).toBeUndefined();
  });

  it("has unique ids", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every key-required HTTP (openai-compat) preset a base URL", () => {
    for (const p of PRESETS) {
      // The native `anthropic` provider needs a key but no base URL; only the
      // openai-compat HTTP providers require one.
      if (p.keyRequired && p.provider === "openai-compat") {
        expect(p.baseUrl.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses only valid provider names", () => {
    for (const p of PRESETS) {
      expect(["gemini-cli", "openai-compat", "anthropic"]).toContain(p.provider);
    }
  });
});
