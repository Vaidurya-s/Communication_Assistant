import { describe, it, expect } from "vitest";
import {
  createEmptyDiagnostics,
  formatDiagnosticsSummary,
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
