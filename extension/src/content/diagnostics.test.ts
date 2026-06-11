import { describe, it, expect } from "vitest";
import {
  createEmptyDiagnostics,
  describeAnomaly,
  formatDiagnosticsSummary,
  hasLayoutAnomaly,
  type Anomaly,
  type ExtractionDiagnostics,
} from "./diagnostics";

function diag(o: Partial<ExtractionDiagnostics> = {}): ExtractionDiagnostics {
  return { ...createEmptyDiagnostics(), ...o };
}

describe("diagnostics", () => {
  it("creates sane empty defaults", () => {
    const d = createEmptyDiagnostics();
    expect(d.messagesFound).toBe(0);
    expect(d.backfillMs).toBe(-1);
    expect(d.anomalies).toEqual([]);
    expect(d.selfDetectionPath).toBe("none");
  });

  it("formats singular vs plural messages and the self path", () => {
    expect(formatDiagnosticsSummary(diag({ messagesFound: 1 }))).toMatch(/^1 msg · /);
    expect(formatDiagnosticsSummary(diag({ messagesFound: 2 }))).toMatch(/^2 msgs · /);
    expect(formatDiagnosticsSummary(diag({ selfDetectionPath: "configured-name" }))).toContain("self configured");
    expect(formatDiagnosticsSummary(diag({ selfDetectionPath: "none" }))).toContain("self unknown");
  });

  it("includes draft / backfill / anomaly segments only when relevant", () => {
    const s = formatDiagnosticsSummary(
      diag({ draftLen: 45, backfillMs: 1200, anomalies: ["conversation-title-missing"] }),
    );
    expect(s).toContain("draft 45ch");
    expect(s).toContain("backfill 1.2s");
    expect(s).toContain("⚠ 1 anomaly");

    const healthy = formatDiagnosticsSummary(diag({ messagesFound: 3 }));
    expect(healthy).not.toContain("⚠");
    expect(healthy).not.toContain("draft");
    expect(healthy).not.toContain("backfill");
  });
});

const ALL_ANOMALIES: Anomaly[] = [
  "zero-messages-on-thread-route",
  "conversation-title-missing",
  "message-list-container-missing",
  "self-name-configured-but-unmatched",
  "no-message-events-matched",
  "gmail-zero-messages",
];

describe("anomaly classification", () => {
  it("flags selector/DOM breaks as layout anomalies", () => {
    expect(hasLayoutAnomaly(["gmail-zero-messages"])).toBe(true);
    expect(hasLayoutAnomaly(["no-message-events-matched", "conversation-title-missing"])).toBe(true);
  });

  it("does not flag the benign self-name miss or an empty list", () => {
    expect(hasLayoutAnomaly(["self-name-configured-but-unmatched"])).toBe(false);
    expect(hasLayoutAnomaly([])).toBe(false);
  });

  it("describes every anomaly with a non-empty phrase", () => {
    for (const a of ALL_ANOMALIES) {
      expect(describeAnomaly(a).length).toBeGreaterThan(0);
    }
  });
});
