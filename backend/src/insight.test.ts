import { describe, it, expect } from "vitest";
import { parseInsight } from "./insight.js";

describe("parseInsight", () => {
  it("parses MEMORY / STRATEGY / FOLLOWUP_AT", () => {
    const raw = "MEMORY: Leads the design guild\nSTRATEGY: Send a written proposal\nFOLLOWUP_AT: 2026-06-10";
    const r = parseInsight(raw, "Maya Chen");
    expect(r.memory_proposal).toEqual({ contact_name: "Maya Chen", note: "Leads the design guild" });
    expect(r.strategy?.text).toBe("Send a written proposal");
    expect(r.strategy?.suggested_followup_at).toBe("2026-06-10T00:00:00.000Z");
  });

  it("treats NONE as null", () => {
    const r = parseInsight("MEMORY: NONE\nSTRATEGY: NONE\nFOLLOWUP_AT: NONE", "Maya");
    expect(r.memory_proposal).toBeNull();
    expect(r.strategy).toBeNull();
  });

  it("returns nulls when the expected lines are missing", () => {
    const r = parseInsight("just some random text", "Maya");
    expect(r.memory_proposal).toBeNull();
    expect(r.strategy).toBeNull();
  });

  it("keeps the strategy but nulls a non-date followup", () => {
    const r = parseInsight("STRATEGY: Circle back soon\nFOLLOWUP_AT: soon", "Maya");
    expect(r.strategy?.text).toBe("Circle back soon");
    expect(r.strategy?.suggested_followup_at).toBeNull();
  });

  it("rejects an impossible date", () => {
    const r = parseInsight("STRATEGY: x\nFOLLOWUP_AT: 2026-13-40", "Maya");
    expect(r.strategy?.suggested_followup_at).toBeNull();
  });

  it("drops a memory when contactName is empty", () => {
    expect(parseInsight("MEMORY: something", "").memory_proposal).toBeNull();
  });

  it("matches line prefixes case-insensitively", () => {
    expect(parseInsight("memory: lower fact", "Maya").memory_proposal?.note).toBe("lower fact");
  });
});
