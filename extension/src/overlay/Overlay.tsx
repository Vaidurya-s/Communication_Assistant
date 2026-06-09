import { useEffect, useRef, useState } from "react";
import type { AnalyzeRequest, BackendResponse, Mode, RuntimeMessage } from "../shared/messages";
import { useDraggable, type Position } from "./useDraggable";
import {
  formatDiagnosticsSummary,
  type ExtractionDiagnostics,
} from "../content/diagnostics";
import { getDebugMode, setDebugMode } from "../shared/debug";
import {
  captureSnapshot,
  clearArmedSnapshot,
  getArmedSnapshot,
  type Snapshot,
} from "../content/snapshot";

const POSITION_KEY = "overlayPosition";
const COLLAPSED_KEY = "overlayCollapsed";
const DEFAULT_POSITION: Position = { x: 24, y: 96 };
const BACKEND_BASE = "http://localhost:8000";

function sendBackground(msg: RuntimeMessage): Promise<RuntimeMessage> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: RuntimeMessage) => resolve(resp));
  });
}

interface ContactInfo {
  name: string;
  suggested_followup_at: string | null;
  notes_count: number;
}

async function fetchContact(name: string): Promise<ContactInfo | null> {
  if (!name) return null;
  try {
    const res = await fetch(`${BACKEND_BASE}/memory/contact/${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.contact) return null;
    return {
      name: j.contact.name,
      suggested_followup_at: j.contact.suggested_followup_at,
      notes_count: Array.isArray(j.notes) ? j.notes.length : 0,
    };
  } catch {
    return null;
  }
}

async function saveAutoNote(contact_name: string, note: string): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_BASE}/memory/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_name, note }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function saveManualNote(contact_name: string, note: string): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_BASE}/memory/notes/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_name, note }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type AnalyzeStatus =
  | { kind: "idle" }
  | { kind: "loading"; mode: Mode }
  | { kind: "error"; message: string };

interface Props {
  onClose: () => void;
}

export function Overlay({ onClose }: Props) {
  const [position, setPosition] = useState<Position>(DEFAULT_POSITION);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [preview, setPreview] = useState<string>("");
  const [status, setStatus] = useState<AnalyzeStatus>({ kind: "idle" });
  const [threadInfo, setThreadInfo] = useState<{ title: string; messages: number; draftLen: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const [memoryProposal, setMemoryProposal] = useState<{ contact_name: string; note: string } | null>(null);
  const [memorySaved, setMemorySaved] = useState(false);
  const [strategy, setStrategy] = useState<BackendResponse["strategy"]>(null);
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);

  const [noteDraft, setNoteDraft] = useState<string>("");
  const [showNoteInput, setShowNoteInput] = useState(false);

  const [diagnostics, setDiagnostics] = useState<ExtractionDiagnostics | null>(null);
  const [debugMode, setDebugModeState] = useState<boolean>(false);
  const [showDiagPane, setShowDiagPane] = useState<boolean>(false);
  const [snapshotExported, setSnapshotExported] = useState(false);
  const [anomalyDismissed, setAnomalyDismissed] = useState(false);

  const previewRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chrome.storage.local.get([POSITION_KEY, COLLAPSED_KEY]).then((all) => {
      const stored = all[POSITION_KEY] as Position | undefined;
      if (stored && typeof stored.x === "number" && typeof stored.y === "number") {
        setPosition(stored);
      }
      if (typeof all[COLLAPSED_KEY] === "boolean") setCollapsed(all[COLLAPSED_KEY]);
    });

    getDebugMode().then(setDebugModeState);

    sendBackground({ type: "STATUS_REQUEST" }).then(async (resp) => {
      if (resp?.type === "STATUS_RESPONSE" && resp.lastContext) {
        const info = {
          title: resp.lastContext.conversation_title,
          messages: resp.lastContext.messages.length,
          draftLen: resp.lastContext.current_draft.length,
        };
        setThreadInfo(info);
        if (resp.lastDiagnostics) setDiagnostics(resp.lastDiagnostics);
        if (resp.lastResponse?.suggested_reply) setPreview(resp.lastResponse.suggested_reply);
        if (resp.lastResponse?.memory_proposal) setMemoryProposal(resp.lastResponse.memory_proposal);
        if (resp.lastResponse?.strategy) setStrategy(resp.lastResponse.strategy);
        const c = await fetchContact(info.title);
        setContactInfo(c);
      }
    });
  }, []);

  const toggleDebugMode = async () => {
    const next = !debugMode;
    setDebugModeState(next);
    await setDebugMode(next);
    if (!next) setShowDiagPane(false);
  };

  const persistPosition = (p: Position) => {
    chrome.storage.local.set({ [POSITION_KEY]: p });
  };

  const { position: livePosition, handleRef } = useDraggable({
    initial: position,
    onCommit: persistPosition,
  });

  useEffect(() => setPosition(livePosition), [livePosition]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    chrome.storage.local.set({ [COLLAPSED_KEY]: next });
  };

  const analyze = async (mode: Mode) => {
    setStatus({ kind: "loading", mode });
    setCopied(false);
    setMemorySaved(false);
    const seed_text = mode === "shorter" || mode === "longer" ? preview : undefined;
    const req: AnalyzeRequest = { type: "ANALYZE_REQUEST", mode, seed_text };
    const resp = await sendBackground(req);

    if (resp?.type === "BACKEND_RESPONSE") {
      const payload = resp.payload as BackendResponse;
      setPreview(payload.suggested_reply ?? "");
      setMemoryProposal(payload.memory_proposal ?? null);
      setStrategy(payload.strategy ?? null);
      const status = await sendBackground({ type: "STATUS_REQUEST" });
      if (status?.type === "STATUS_RESPONSE" && status.lastContext) {
        const info = {
          title: status.lastContext.conversation_title,
          messages: status.lastContext.messages.length,
          draftLen: status.lastContext.current_draft.length,
        };
        setThreadInfo(info);
        if (status.lastDiagnostics) {
          setDiagnostics(status.lastDiagnostics);
          setAnomalyDismissed(false);
        }
        const c = await fetchContact(info.title);
        setContactInfo(c);
      }
      setStatus({ kind: "idle" });
      return;
    }
    if (resp?.type === "ERROR") {
      setStatus({ kind: "error", message: resp.message });
      return;
    }
    setStatus({ kind: "error", message: "unexpected response" });
  };

  const copyPreview = async () => {
    if (!preview) return;
    await navigator.clipboard.writeText(preview);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const onSaveProposal = async () => {
    if (!memoryProposal) return;
    const ok = await saveAutoNote(memoryProposal.contact_name, memoryProposal.note);
    if (ok) {
      setMemorySaved(true);
      setMemoryProposal(null);
      const c = await fetchContact(memoryProposal.contact_name);
      setContactInfo(c);
    }
  };

  const onSaveManual = async () => {
    if (!threadInfo?.title || !noteDraft.trim()) return;
    const ok = await saveManualNote(threadInfo.title, noteDraft.trim());
    if (ok) {
      setNoteDraft("");
      setShowNoteInput(false);
      const c = await fetchContact(threadInfo.title);
      setContactInfo(c);
    }
  };

  const copyFollowupForCalendar = async () => {
    if (!contactInfo?.suggested_followup_at || !contactInfo.name) return;
    const due = contactInfo.suggested_followup_at.slice(0, 10);
    const line = strategy?.text
      ? `Follow up with ${contactInfo.name} (due ${due}): ${strategy.text}`
      : `Follow up with ${contactInfo.name} (due ${due})`;
    await navigator.clipboard.writeText(line);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const loadingMode = status.kind === "loading" ? status.mode : null;
  const followupChip = renderFollowupChip(contactInfo);
  // Re-read on each render — refreshed by state updates after each analyze.
  const armedSnap = getArmedSnapshot();

  const exportSnapshot = async (snap: Snapshot) => {
    await navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
    setSnapshotExported(true);
    setTimeout(() => setSnapshotExported(false), 1500);
  };

  const onDismissAnomaly = () => {
    clearArmedSnapshot();
    setAnomalyDismissed(true);
  };

  const onManualCapture = () => {
    void exportSnapshot(captureSnapshot());
  };

  return (
    <div style={{ ...rootStyle, left: livePosition.x, top: livePosition.y }}>
      <div ref={handleRef} style={headerStyle}>
        <span style={titleStyle}>Comms Assistant</span>
        <span style={spacerStyle} />
        <button onClick={toggleCollapsed} style={iconBtnStyle} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? "▢" : "—"}
        </button>
        <button onClick={onClose} style={iconBtnStyle} title="Close">
          ×
        </button>
      </div>

      {!collapsed && (
        <div style={bodyStyle}>
          {armedSnap && !anomalyDismissed && (
            <div style={anomalyCardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                ⚠ Extraction anomaly detected
              </div>
              <div style={{ fontSize: 11, marginBottom: 6, color: "#7a3e00" }}>
                {(armedSnap.diagnostics?.anomalies ?? []).join(", ") || "see snapshot"}
              </div>
              <div style={btnRowStyle}>
                <button onClick={() => void exportSnapshot(armedSnap)} style={primaryBtnStyle}>
                  {snapshotExported ? "Copied ✓" : "Export JSON"}
                </button>
                <button onClick={onDismissAnomaly} style={ghostBtnStyle}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div style={statusLineStyle}>
            {threadInfo ? (
              <>
                <strong>{threadInfo.title || "(unknown thread)"}</strong>
                {" · "}
                {threadInfo.messages} msg
                {threadInfo.draftLen > 0 && <> · draft {threadInfo.draftLen} ch</>}
                {contactInfo && contactInfo.notes_count > 0 && (
                  <> · 📝 {contactInfo.notes_count} note{contactInfo.notes_count === 1 ? "" : "s"}</>
                )}
              </>
            ) : (
              <span style={{ color: "#666" }}>Open a LinkedIn thread to begin.</span>
            )}
          </div>

          {followupChip && (
            <div style={followupChipStyle} onClick={copyFollowupForCalendar} title="Click to copy a one-line summary">
              🔔 {followupChip.label} — click to copy for Calendar/Tasks
            </div>
          )}

          <div style={btnRowStyle}>
            <ActionButton label="Suggest" onClick={() => analyze("suggest")} loading={loadingMode === "suggest" || loadingMode === "continue_draft"} />
            <ActionButton label="Follow-up" onClick={() => analyze("follow_up")} loading={loadingMode === "follow_up"} />
          </div>
          <div style={btnRowStyle}>
            <ActionButton label="Shorter" onClick={() => analyze("shorter")} loading={loadingMode === "shorter"} disabled={!preview} />
            <ActionButton label="Longer" onClick={() => analyze("longer")} loading={loadingMode === "longer"} disabled={!preview} />
          </div>

          <textarea
            ref={previewRef}
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
            placeholder="Suggestion will appear here. You can edit before copying."
            style={previewStyle}
            rows={6}
          />

          <div style={btnRowStyle}>
            <button onClick={copyPreview} disabled={!preview} style={primaryBtnStyle}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button onClick={() => setPreview("")} disabled={!preview} style={ghostBtnStyle}>
              Clear
            </button>
          </div>

          {strategy && (
            <div style={strategyStyle}>💡 {strategy.text}</div>
          )}

          {memoryProposal && !memorySaved && (
            <div style={memoryCardStyle}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Save this about {memoryProposal.contact_name}?</div>
              <div style={{ marginBottom: 6 }}>{memoryProposal.note}</div>
              <div style={btnRowStyle}>
                <button onClick={onSaveProposal} style={primaryBtnStyle}>
                  Save
                </button>
                <button onClick={() => setMemoryProposal(null)} style={ghostBtnStyle}>
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {threadInfo?.title && (
            <div>
              {showNoteInput ? (
                <div style={memoryCardStyle}>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={`Note about ${threadInfo.title}…`}
                    style={{ ...previewStyle, minHeight: 40 }}
                    rows={2}
                  />
                  <div style={btnRowStyle}>
                    <button onClick={onSaveManual} disabled={!noteDraft.trim()} style={primaryBtnStyle}>
                      Save note
                    </button>
                    <button onClick={() => { setShowNoteInput(false); setNoteDraft(""); }} style={ghostBtnStyle}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowNoteInput(true)} style={ghostBtnStyle}>
                  + Add note manually
                </button>
              )}
            </div>
          )}

          {status.kind === "error" && (
            <div style={errorStyle}>{status.message}</div>
          )}

          {/* Footer: one-line diagnostics summary + debug toggle */}
          <div style={footerStyle}>
            <span style={footerSummaryStyle}>
              {diagnostics ? formatDiagnosticsSummary(diagnostics) : "no extraction yet"}
            </span>
            <span style={spacerStyle} />
            <button
              onClick={toggleDebugMode}
              style={footerToggleStyle}
              title={debugMode ? "Debug mode on" : "Debug mode off"}
            >
              {debugMode ? "debug ●" : "debug ○"}
            </button>
            {debugMode && (
              <button
                onClick={() => setShowDiagPane((v) => !v)}
                style={footerToggleStyle}
                title="Toggle diagnostics detail"
              >
                {showDiagPane ? "▾" : "▸"}
              </button>
            )}
          </div>

          {debugMode && showDiagPane && (
            <>
              <pre style={diagPaneStyle}>
                {diagnostics
                  ? JSON.stringify(diagnostics, null, 2)
                  : "(no extraction recorded yet)"}
              </pre>
              <button onClick={onManualCapture} style={ghostBtnStyle}>
                {snapshotExported ? "Snapshot copied ✓" : "Capture snapshot"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  loading,
  disabled,
}: {
  label: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      style={{
        ...actionBtnStyle,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {loading ? "…" : label}
    </button>
  );
}

function renderFollowupChip(c: ContactInfo | null): { label: string } | null {
  if (!c?.suggested_followup_at) return null;
  const due = new Date(c.suggested_followup_at);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const diffH = (due.getTime() - now.getTime()) / 36e5;
  if (diffH < -24 * 14) return null; // more than 2 weeks past — stale, hide
  if (diffH > 24 * 7) return null; // more than a week in the future — not yet
  const date = c.suggested_followup_at.slice(0, 10);
  if (diffH < 0) return { label: `Follow-up overdue (was ${date})` };
  if (diffH < 24) return { label: `Follow-up due today (${date})` };
  return { label: `Follow-up due ${date}` };
}

// --- styles ----------------------------------------------------------------

const rootStyle: React.CSSProperties = {
  position: "fixed",
  width: 320,
  background: "white",
  border: "1px solid #d0d7de",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: 13,
  color: "#1d1d1f",
  zIndex: 2147483647,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 8px",
  background: "#0a66c2",
  color: "white",
  cursor: "move",
  borderTopLeftRadius: 8,
  borderTopRightRadius: 8,
  userSelect: "none",
};

const titleStyle: React.CSSProperties = { fontWeight: 600, fontSize: 12 };
const spacerStyle: React.CSSProperties = { flex: 1 };

const iconBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "white",
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 6px",
};

const bodyStyle: React.CSSProperties = { padding: 10, display: "flex", flexDirection: "column", gap: 8 };
const statusLineStyle: React.CSSProperties = { fontSize: 12, color: "#333" };
const btnRowStyle: React.CSSProperties = { display: "flex", gap: 6 };

const actionBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "5px 8px",
  fontSize: 12,
  border: "1px solid #d0d7de",
  background: "#f6f8fa",
  borderRadius: 4,
  cursor: "pointer",
};

const previewStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 8,
  fontSize: 12,
  fontFamily: "inherit",
  border: "1px solid #d0d7de",
  borderRadius: 4,
  resize: "vertical",
};

const primaryBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid #0a66c2",
  background: "#0a66c2",
  color: "white",
  borderRadius: 4,
  cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  border: "1px solid #d0d7de",
  background: "white",
  borderRadius: 4,
  cursor: "pointer",
};

const strategyStyle: React.CSSProperties = {
  background: "#fff8e1",
  border: "1px solid #ffe082",
  padding: 8,
  borderRadius: 4,
  fontSize: 12,
};

const memoryCardStyle: React.CSSProperties = {
  background: "#eef7ee",
  border: "1px solid #cfe5cf",
  padding: 8,
  borderRadius: 4,
  fontSize: 12,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const followupChipStyle: React.CSSProperties = {
  background: "#fff3e0",
  border: "1px solid #ffb74d",
  padding: "6px 8px",
  borderRadius: 4,
  fontSize: 11,
  cursor: "pointer",
  fontWeight: 500,
};

const errorStyle: React.CSSProperties = {
  background: "#fdecea",
  color: "#b00020",
  padding: 6,
  borderRadius: 4,
  fontSize: 11,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginTop: 2,
  paddingTop: 6,
  borderTop: "1px solid #eef0f2",
  fontSize: 10,
  color: "#666",
};

const footerSummaryStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  color: "#666",
};

const footerToggleStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #d0d7de",
  borderRadius: 3,
  fontSize: 10,
  padding: "2px 6px",
  cursor: "pointer",
  color: "#666",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const diagPaneStyle: React.CSSProperties = {
  background: "#0d1117",
  color: "#e6edf3",
  padding: 8,
  borderRadius: 4,
  fontSize: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  maxHeight: 240,
  overflow: "auto",
  whiteSpace: "pre",
  margin: 0,
};

const anomalyCardStyle: React.CSSProperties = {
  background: "#fff4e5",
  border: "1px solid #ffb74d",
  padding: 8,
  borderRadius: 4,
  fontSize: 12,
  color: "#7a3e00",
};
