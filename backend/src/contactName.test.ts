import { describe, it, expect } from "vitest";
import { isPollutedName, sanitizeContactName } from "./contactName.js";

describe("sanitizeContactName", () => {
  it("leaves a clean name exactly alone", () => {
    expect(sanitizeContactName("Michal Krelina")).toBe("Michal Krelina");
    expect(sanitizeContactName("Dr. Rohitkumar R. Upadhyay")).toBe("Dr. Rohitkumar R. Upadhyay");
  });

  it("cleans the real polluted row from the live database", () => {
    expect(sanitizeContactName("Divyanshu Gupta Status is reachable Mobile • 10h")).toBe(
      "Divyanshu Gupta",
    );
  });

  it("collapses the newlines an inline scrape leaves behind", () => {
    expect(sanitizeContactName("Divyanshu\n   \n  Gupta")).toBe("Divyanshu Gupta");
  });

  it("strips the other presence markers", () => {
    expect(sanitizeContactName("Reed Wittman • 2h")).toBe("Reed Wittman");
    expect(sanitizeContactName("Sam Grove Active now")).toBe("Sam Grove");
    expect(sanitizeContactName("Ada Lovelace Online now")).toBe("Ada Lovelace");
  });

  it("caps a runaway name", () => {
    expect(sanitizeContactName("x".repeat(200))).toHaveLength(60);
  });

  it("returns empty for nothing usable", () => {
    expect(sanitizeContactName("")).toBe("");
    expect(sanitizeContactName(null)).toBe("");
    expect(sanitizeContactName("   \n  ")).toBe("");
  });

  it("keeps the original rather than dropping a contact when the pattern over-matches", () => {
    // If stripping would leave nothing, the rule was wrong about this string —
    // an untidy name beats a contact that vanishes.
    expect(sanitizeContactName("• 10h")).toBe("• 10h");
  });

  it("does not eat legitimate names that merely contain 'is' or 'active'", () => {
    // Over-matching corrupts real names and forks a contact into two rows,
    // which is worse than leaving one slightly untidy.
    expect(sanitizeContactName("Louisa Isaacs")).toBe("Louisa Isaacs");
    expect(sanitizeContactName("Active Minds Foundation")).toBe("Active Minds Foundation");
  });
});

describe("isPollutedName", () => {
  it("flags only names that would change", () => {
    expect(isPollutedName("Michal Krelina")).toBe(false);
    expect(isPollutedName("Divyanshu Gupta Status is reachable Mobile • 10h")).toBe(true);
  });
});
