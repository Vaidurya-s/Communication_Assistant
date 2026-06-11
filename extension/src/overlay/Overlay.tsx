import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzeRequest, BackendResponse, Mode, RuntimeMessage } from "../shared/messages";
import { useDraggable, type Position } from "./useDraggable";
import {
  formatDiagnosticsSummary,
  type ExtractionDiagnostics,
} from "../content/diagnostics";
import { getDebugMode, setDebugMode } from "../shared/debug";
import { getSelfNameSetting, setSelfNameSetting } from "../shared/storage";
import {
  captureSnapshot,
  clearArmedSnapshot,
  getArmedSnapshot,
  type Snapshot,
} from "../content/snapshot";
import { exportSnapshot as exportSnapshotApi, type SnapshotExportResult } from "./snapshotApi";

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

interface Health {
  voiceProfileChars: number;
  voiceProfileOk: boolean;
  provider: string;
}

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BACKEND_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      voiceProfileChars: j.voiceProfileChars ?? 0,
      voiceProfileOk: !!j.voiceProfileOk,
      provider: j.provider ?? "?",
    };
  } catch {
    return null;
  }
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

async function postFeedback(body: {
  rating: "up" | "down";
  note?: string;
  contact?: string;
  suggestion?: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND_BASE}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// One-tap steers for the common rewrites.
const TONES: ReadonlyArray<{ label: string; steer: string }> = [
  { label: "Warmer", steer: "Make it warmer and more personable, without being gushy." },
  { label: "Direct", steer: "Make it more direct and concise — get to the point." },
  { label: "Formal", steer: "Make it more formal and professional." },
  { label: "Decline", steer: "Politely decline while staying warm and leaving the door open." },
];

type AnalyzeStatus =
  | { kind: "idle" }
  | { kind: "loading"; mode: Mode }
  | { kind: "error"; message: string };

type BackendHealth = "checking" | "online" | "offline";

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
  const [snapshotExport, setSnapshotExport] = useState<SnapshotExportResult | null>(null);
  const [anomalyDismissed, setAnomalyDismissed] = useState(false);

  const [backendHealth, setBackendHealth] = useState<BackendHealth>("checking");
  const [health, setHealth] = useState<Health | null>(null);

  // Onboarding: self-name + steer + feedback.
  const [selfName, setSelfName] = useState<string>("");
  const [nameInput, setNameInput] = useState<string>("");
  const [nameSaved, setNameSaved] = useState(false);
  const [steer, setSteer] = useState<string>("");
  const [feedbackGiven, setFeedbackGiven] = useState<"up" | "down" | null>(null);
  const [showFeedbackNote, setShowFeedbackNote] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState("");

  const previewRef = useRef<HTMLTextAreaElement>(null);

  const refreshHealth = useCallback(async () => {
    setBackendHealth("checking");
    const h = await fetchHealth();
    setHealth(h);
    setBackendHealth(h ? "online" : "offline");
  }, []);

  useEffect(() => {
    chrome.storage.local.get([POSITION_KEY, COLLAPSED_KEY]).then((all) => {
      const stored = all[POSITION_KEY] as Position | undefined;
      if (stored && typeof stored.x === "number" && typeof stored.y === "number") {
        setPosition(stored);
      }
      if (typeof all[COLLAPSED_KEY] === "boolean") setCollapsed(all[COLLAPSED_KEY]);
    });

    getDebugMode().then(setDebugModeState);
    getSelfNameSetting().then((n) => {
      setSelfName(n);
      setNameInput(n);
    });

    void refreshHealth();

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
  }, [refreshHealth]);

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

  const saveName = async () => {
    const n = nameInput.trim();
    await setSelfNameSetting(n);
    setSelfName(n);
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 1200);
  };

  // `steerOverride` lets tone chips / Regenerate inject a steer without waiting
  // on the steer state to settle.
  const analyze = useCallback(
    async (mode: Mode, opts?: { steerOverride?: string }) => {
      setStatus({ kind: "loading", mode });
      setCopied(false);
      setMemorySaved(false);
      setFeedbackGiven(null);
      setShowFeedbackNote(false);
      const seed_text = mode === "shorter" || mode === "longer" ? preview : undefined;
      const steerVal = (opts?.steerOverride ?? steer).trim() || undefined;
      const req: AnalyzeRequest = { type: "ANALYZE_REQUEST", mode, seed_text, steer: steerVal };
      const resp = await sendBackground(req);

      if (resp?.type === "BACKEND_RESPONSE") {
        const payload = resp.payload as BackendResponse;
        setPreview(payload.suggested_reply ?? "");
        setMemoryProposal(payload.memory_proposal ?? null);
        setStrategy(payload.strategy ?? null);
        setBackendHealth("online");
        const statusResp = await sendBackground({ type: "STATUS_REQUEST" });
        if (statusResp?.type === "STATUS_RESPONSE" && statusResp.lastContext) {
          const info = {
            title: statusResp.lastContext.conversation_title,
            messages: statusResp.lastContext.messages.length,
            draftLen: statusResp.lastContext.current_draft.length,
          };
          setThreadInfo(info);
          if (statusResp.lastDiagnostics) {
            setDiagnostics(statusResp.lastDiagnostics);
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
        if (/fetch|backend|ECONN|network/i.test(resp.message)) void refreshHealth();
        return;
      }
      setStatus({ kind: "error", message: "unexpected response" });
    },
    [preview, refreshHealth, steer],
  );

  const regenerate = useCallback(() => {
    const base = steer.trim() ? steer.trim() + ". " : "";
    void analyze("suggest", {
      steerOverride:
        base + "Give a noticeably different alternative — change the opening and structure from the obvious draft.",
    });
  }, [analyze, steer]);

  const applyTone = (tone: (typeof TONES)[number]) => {
    setSteer(tone.steer);
    void analyze("suggest", { steerOverride: tone.steer });
  };

  const copyPreview = useCallback(async () => {
    if (!preview) return;
    await navigator.clipboard.writeText(preview);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [preview]);

  const onThumbUp = async () => {
    setFeedbackGiven("up");
    await postFeedback({ rating: "up", contact: threadInfo?.title, suggestion: preview });
  };

  const onThumbDown = () => {
    setShowFeedbackNote(true);
  };

  const submitThumbDown = async () => {
    setFeedbackGiven("down");
    setShowFeedbackNote(false);
    await postFeedback({
      rating: "down",
      note: feedbackNote.trim() || undefined,
      contact: threadInfo?.title,
      suggestion: preview,
    });
    setFeedbackNote("");
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

  // Keyboard shortcuts. Alt+key avoids LinkedIn's Enter-to-send and works the
  // same on macOS (Option) and Windows/Linux (Alt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      switch (key) {
        case "s":
          e.preventDefault();
          void analyze("suggest");
          return;
        case "f":
          e.preventDefault();
          void analyze("follow_up");
          return;
        case "h":
          if (!preview) return;
          e.preventDefault();
          void analyze("shorter");
          return;
        case "l":
          if (!preview) return;
          e.preventDefault();
          void analyze("longer");
          return;
        case "r":
          if (!preview) return;
          e.preventDefault();
          regenerate();
          return;
        case "c":
          if (!preview) return;
          e.preventDefault();
          void copyPreview();
          return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [analyze, copyPreview, regenerate, preview]);

  const loadingMode = status.kind === "loading" ? status.mode : null;
  const isLoading = status.kind === "loading";
  const followupChip = renderFollowupChip(contactInfo);
  const armedSnap = getArmedSnapshot();

  const exportSnapshot = async (snap: Snapshot) => {
    const result = await exportSnapshotApi(snap);
    setSnapshotExport(result);
    setTimeout(() => setSnapshotExport(null), 2200);
  };

  const snapshotButtonLabel = (defaultLabel: string): string => {
    if (!snapshotExport) return defaultLabel;
    if (snapshotExport.kind === "saved") return `Saved ${snapshotExport.filename} ✓`;
    if (snapshotExport.kind === "clipboard") return "Backend offline — copied ✓";
    return `Failed: ${snapshotExport.reason}`;
  };

  const onDismissAnomaly = () => {
    clearArmedSnapshot();
    setAnomalyDismissed(true);
  };

  const onManualCapture = () => {
    void exportSnapshot(captureSnapshot());
  };

  // Onboarding checklist shows until the user has run their first analyze.
  const voiceOk = backendHealth === "online" && !!health?.voiceProfileOk;
  const nameOk = selfName.trim().length > 0;
  const setupComplete = backendHealth === "online" && voiceOk && nameOk;
  const showChecklist = !threadInfo && !setupComplete;

  return (
    <div className="ca-root" style={{ left: livePosition.x, top: livePosition.y }}>
      <div ref={handleRef} className="ca-header">
        <span className="ca-title">Comms Assistant</span>
        <span className="ca-spacer" />
        <button onClick={toggleCollapsed} className="ca-icon-btn" title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? "▢" : "—"}
        </button>
        <button onClick={onClose} className="ca-icon-btn" title="Close">
          ×
        </button>
      </div>

      {!collapsed && (
        <div className="ca-body">
          {backendHealth === "offline" && (
            <div className="ca-offline">
              <span>⚠ Backend offline (localhost:8000)</span>
              <span className="ca-spacer" />
              <button onClick={() => void refreshHealth()} className="ca-retry">
                Retry
              </button>
            </div>
          )}

          {showChecklist && (
            <div className="ca-checklist">
              <div className="ca-card-title">Finish setup</div>
              <ChecklistItem
                ok={backendHealth === "online"}
                label="Backend running"
                hint={backendHealth === "online" ? `provider: ${health?.provider ?? "?"}` : "run `npm start`"}
              />
              <ChecklistItem
                ok={voiceOk}
                label="Voice profile loaded"
                hint={
                  voiceOk
                    ? `${health?.voiceProfileChars ?? 0} chars`
                    : "see SETUP.md → `npm run init-voice`"
                }
              />
              <ChecklistItem ok={nameOk} label="Your name set" hint={nameOk ? selfName : undefined} />
              {!nameOk && (
                <div className="ca-row" style={{ marginTop: 6 }}>
                  <input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="Your LinkedIn display name"
                    className="ca-input"
                  />
                  <button onClick={saveName} disabled={!nameInput.trim()} className="ca-btn ca-btn-primary">
                    {nameSaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
              )}
            </div>
          )}

          {armedSnap && !anomalyDismissed && (
            <div className="ca-anomaly">
              <div className="ca-card-title">⚠ Extraction anomaly detected</div>
              <div className="ca-anomaly-sub">
                {(armedSnap.diagnostics?.anomalies ?? []).join(", ") || "see snapshot"}
              </div>
              <div className="ca-row">
                <button onClick={() => void exportSnapshot(armedSnap)} className="ca-btn ca-btn-primary">
                  {snapshotButtonLabel("Save snapshot")}
                </button>
                <button onClick={onDismissAnomaly} className="ca-btn ca-btn-ghost">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="ca-status">
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
              <span className="ca-muted">Open a LinkedIn thread, then click Suggest.</span>
            )}
          </div>

          {followupChip && (
            <div className="ca-followup" onClick={copyFollowupForCalendar} title="Click to copy a one-line summary">
              🔔 {followupChip.label} — click to copy for Calendar/Tasks
            </div>
          )}

          {/* Steer + tone presets */}
          <input
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            placeholder="Steer it (optional): 'make it warmer', 'mention the demo'…"
            className="ca-input"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void analyze("suggest");
              }
            }}
          />
          <div className="ca-chips">
            {TONES.map((t) => (
              <button
                key={t.label}
                onClick={() => applyTone(t)}
                disabled={isLoading}
                className="ca-chip"
                title={t.steer}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="ca-row">
            <ActionButton
              label="Suggest"
              shortcut="Alt+S"
              onClick={() => analyze("suggest")}
              loading={loadingMode === "suggest" || loadingMode === "continue_draft"}
            />
            <ActionButton
              label="Follow-up"
              shortcut="Alt+F"
              onClick={() => analyze("follow_up")}
              loading={loadingMode === "follow_up"}
            />
          </div>
          <div className="ca-row">
            <ActionButton
              label="Shorter"
              shortcut="Alt+H"
              onClick={() => analyze("shorter")}
              loading={loadingMode === "shorter"}
              disabled={!preview}
            />
            <ActionButton
              label="Longer"
              shortcut="Alt+L"
              onClick={() => analyze("longer")}
              loading={loadingMode === "longer"}
              disabled={!preview}
            />
          </div>

          <textarea
            ref={previewRef}
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
            placeholder="Suggestion will appear here. You can edit before copying."
            className="ca-preview"
            rows={6}
          />

          {/* Feedback on the current suggestion */}
          {preview && status.kind !== "loading" && (
            <div className="ca-feedback">
              {feedbackGiven ? (
                <span className="ca-ok">Thanks — noted for your next profile refresh.</span>
              ) : showFeedbackNote ? (
                <div className="ca-feedback-note">
                  <input
                    value={feedbackNote}
                    onChange={(e) => setFeedbackNote(e.target.value)}
                    placeholder="What was off? (optional)"
                    className="ca-input"
                    autoFocus
                  />
                  <button onClick={submitThumbDown} className="ca-btn ca-btn-primary">
                    Send
                  </button>
                </div>
              ) : (
                <>
                  <span className="ca-muted">Sound like you?</span>
                  <button onClick={onThumbUp} className="ca-thumb" title="Yes — sounds like me">
                    👍
                  </button>
                  <button onClick={onThumbDown} className="ca-thumb" title="Not quite — tell it why">
                    👎
                  </button>
                </>
              )}
            </div>
          )}

          <div className="ca-row">
            <button onClick={copyPreview} disabled={!preview} className="ca-btn ca-btn-primary" title="Copy (Alt+C)">
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button onClick={regenerate} disabled={!preview || isLoading} className="ca-btn ca-btn-ghost" title="Regenerate (Alt+R)">
              ↻ Regenerate
            </button>
            <button onClick={() => setPreview("")} disabled={!preview} className="ca-btn ca-btn-ghost">
              Clear
            </button>
          </div>

          {strategy && <div className="ca-strategy">💡 {strategy.text}</div>}

          {memoryProposal && !memorySaved && (
            <div className="ca-memory">
              <div className="ca-card-title">Save this about {memoryProposal.contact_name}?</div>
              <div className="ca-memory-note">{memoryProposal.note}</div>
              <div className="ca-row">
                <button onClick={onSaveProposal} className="ca-btn ca-btn-primary">
                  Save
                </button>
                <button onClick={() => setMemoryProposal(null)} className="ca-btn ca-btn-ghost">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {threadInfo?.title && (
            <div>
              {showNoteInput ? (
                <div className="ca-memory">
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={`Note about ${threadInfo.title}…`}
                    className="ca-preview ca-preview-sm"
                    rows={2}
                  />
                  <div className="ca-row">
                    <button onClick={onSaveManual} disabled={!noteDraft.trim()} className="ca-btn ca-btn-primary">
                      Save note
                    </button>
                    <button onClick={() => { setShowNoteInput(false); setNoteDraft(""); }} className="ca-btn ca-btn-ghost">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowNoteInput(true)} className="ca-btn ca-btn-ghost ca-btn-block">
                  + Add note manually
                </button>
              )}
            </div>
          )}

          {status.kind === "error" && <div className="ca-error">{status.message}</div>}

          <div className="ca-footer">
            <span className="ca-foot-summary">
              {diagnostics ? formatDiagnosticsSummary(diagnostics) : "no extraction yet"}
            </span>
            <span className="ca-spacer" />
            <span title={SHORTCUT_HELP} className="ca-kbd">⌨</span>
            <button
              onClick={toggleDebugMode}
              className="ca-foot-toggle"
              title={debugMode ? "Debug mode on" : "Debug mode off"}
            >
              {debugMode ? "debug ●" : "debug ○"}
            </button>
            {debugMode && (
              <button onClick={() => setShowDiagPane((v) => !v)} className="ca-foot-toggle" title="Toggle diagnostics detail">
                {showDiagPane ? "▾" : "▸"}
              </button>
            )}
          </div>

          {debugMode && showDiagPane && (
            <>
              <pre className="ca-diag">
                {diagnostics ? JSON.stringify(diagnostics, null, 2) : "(no extraction recorded yet)"}
              </pre>
              <button onClick={onManualCapture} className="ca-btn ca-btn-ghost ca-btn-block">
                {snapshotButtonLabel("Capture snapshot")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const SHORTCUT_HELP =
  "Shortcuts:\n" +
  "  Alt+S — Suggest\n" +
  "  Alt+F — Follow-up\n" +
  "  Alt+H — Shorter\n" +
  "  Alt+L — Longer\n" +
  "  Alt+R — Regenerate\n" +
  "  Alt+C — Copy preview";

function ChecklistItem({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="ca-check">
      <span className={`ca-check-ico ${ok ? "is-ok" : "is-todo"}`}>{ok ? "✓" : "○"}</span>
      <span>{label}</span>
      {hint && <span className="ca-check-hint">— {hint}</span>}
    </div>
  );
}

function ActionButton({
  label,
  shortcut,
  onClick,
  loading,
  disabled,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const isDisabled = !!disabled || !!loading;
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      className="ca-action"
    >
      {loading && <Spinner />}
      <span>{label}</span>
    </button>
  );
}

function Spinner() {
  return <span aria-label="loading" className="ca-spinner" />;
}

function renderFollowupChip(c: ContactInfo | null): { label: string } | null {
  if (!c?.suggested_followup_at) return null;
  const due = new Date(c.suggested_followup_at);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  const diffH = (due.getTime() - now.getTime()) / 36e5;
  if (diffH < -24 * 14) return null;
  if (diffH > 24 * 7) return null;
  const date = c.suggested_followup_at.slice(0, 10);
  if (diffH < 0) return { label: `Follow-up overdue (was ${date})` };
  if (diffH < 24) return { label: `Follow-up due today (${date})` };
  return { label: `Follow-up due ${date}` };
}
