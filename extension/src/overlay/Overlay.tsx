import { useCallback, useEffect, useRef, useState } from "react";
import { ANALYZE_STREAM_PORT } from "../shared/messages";
import type {
  AnalyzeRequest,
  AnalyzeStreamEvent,
  BackendResponse,
  Mode,
  RuntimeMessage,
} from "../shared/messages";
import { useDraggable, type Position } from "./useDraggable";
import {
  describeAnomaly,
  formatDiagnosticsSummary,
  hasLayoutAnomaly,
  type ExtractionDiagnostics,
} from "../content/diagnostics";
import { getDebugMode, setDebugMode } from "../shared/debug";
import { getSelfNameSetting, setSelfNameSetting, getEditMiningSetting } from "../shared/storage";
import {
  captureSnapshot,
  clearArmedSnapshot,
  getArmedSnapshot,
  type Snapshot,
} from "../content/snapshot";
import { exportSnapshot as exportSnapshotApi, type SnapshotExportResult } from "./snapshotApi";
import { backendFetch } from "../shared/backend";
import type { ColdOpenInfo } from "./mount";

const POSITION_KEY = "overlayPosition";
const COLLAPSED_KEY = "overlayCollapsed";
const DEFAULT_POSITION: Position = { x: 24, y: 96 };

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
    const res = await backendFetch(`/health`, { signal: AbortSignal.timeout(3000) });
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
    const res = await backendFetch(`/memory/contact/${encodeURIComponent(name)}`);
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
    const res = await backendFetch(`/memory/notes`, {
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
    const res = await backendFetch(`/memory/notes/manual`, {
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
  /** Voice section a 👎 chip targets (must match backend SECTION_KEYS). */
  section?: string;
}): Promise<boolean> {
  try {
    const res = await backendFetch(`/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Structured 👎 chips. Each maps a vague thumbs-down to a specific voice section
// (one of the backend SECTION_KEYS) plus a canonical correction note, so the
// feedback routes to the right section instead of "something was off". The
// section strings MUST match backend voiceSections.SECTION_KEYS.
const DOWN_CHIPS: ReadonlyArray<{ label: string; section: string; note: string }> = [
  { label: "Too formal", section: "registers", note: "Too formal/stiff — loosen the register." },
  { label: "Too long", section: "rhythm", note: "Too long — I write shorter; tighten the rhythm." },
  { label: "Not my opener", section: "openers", note: "The opening didn't sound like how I open." },
  { label: "Stiff closing", section: "closings", note: "The closing felt stiff — not how I sign off." },
  { label: "Too generic", section: "vocabulary", note: "Too generic — use my specific phrasing, cut filler." },
];

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
  /** When set, the overlay renders its cold-open (first-message) variant. */
  coldOpen?: ColdOpenInfo | null;
}

export function Overlay({ onClose, coldOpen }: Props) {
  const [position, setPosition] = useState<Position>(DEFAULT_POSITION);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [preview, setPreview] = useState<string>("");
  const [status, setStatus] = useState<AnalyzeStatus>({ kind: "idle" });
  const [threadInfo, setThreadInfo] = useState<{ title: string; messages: number; draftLen: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // "Another take": the alternative draft shown beside the main one. `null` =
  // no alternative on screen; "" = one is streaming in.
  const [variant, setVariant] = useState<string | null>(null);
  const [variantLoading, setVariantLoading] = useState(false);
  // Seconds spent waiting on the model, from the stream's heartbeat. Some
  // providers take a minute or more before the first token, and without this the
  // overlay just sat there looking broken.
  const [waitedSec, setWaitedSec] = useState<number | null>(null);
  // "Add to my corpus": a reviewed exchange on its way to voice_profile/. null =
  // the panel is closed. The review step is the trust gate — see corpus.ts.
  const [corpusDraft, setCorpusDraft] = useState<
    { contact: string; mine: string; theirs: string; tag: string } | null
  >(null);
  const [corpusStatus, setCorpusStatus] = useState<string>("");

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
  // Cold-open only: the user's reason for reaching out ("What's this about?").
  const [intent, setIntent] = useState<string>("");
  const [feedbackGiven, setFeedbackGiven] = useState<"up" | "down" | null>(null);
  const [showFeedbackNote, setShowFeedbackNote] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState("");
  // Deterministic voice-lint hits: words the user's profile says to avoid that
  // appear in the current draft.
  const [lintTerms, setLintTerms] = useState<string[]>([]);
  // Explainability: the deterministic inputs that shaped the latest draft.
  const [explain, setExplain] = useState<{
    context_items: Array<{ type: string; title: string }>;
    notes_used: number;
    voice_chars: number;
  } | null>(null);

  const previewRef = useRef<HTMLTextAreaElement>(null);
  // Edit-mining (opt-in): the model's last suggestion + whether capture is on,
  // in refs so the copy handler reads them without re-subscribing.
  const originalSuggestionRef = useRef("");
  const editMiningRef = useRef(false);

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
    getEditMiningSetting().then((v) => (editMiningRef.current = v));
    getSelfNameSetting().then((n) => {
      setSelfName(n);
      setNameInput(n);
    });

    void refreshHealth();

    // Prewarm the backend's prompt cache while the user reads the thread, so the
    // first Suggest is a cache read. Best-effort: a no-op on providers that can't
    // be primed, and any failure is harmless (the draft path still works).
    void backendFetch("/warm", { method: "POST" }).catch(() => {});

    sendBackground({ type: "STATUS_REQUEST" }).then(async (resp) => {
      if (resp?.type === "STATUS_RESPONSE" && resp.lastContext) {
        const info = {
          title: resp.lastContext.conversation_title,
          messages: resp.lastContext.messages.length,
          draftLen: resp.lastContext.current_draft.length,
        };
        setThreadInfo(info);
        if (resp.lastDiagnostics) setDiagnostics(resp.lastDiagnostics);
        if (resp.lastResponse?.suggested_reply) {
          setPreview(resp.lastResponse.suggested_reply);
          originalSuggestionRef.current = resp.lastResponse.suggested_reply;
        }
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

  // Voice lint: debounce-check the draft (and any manual edits) against the
  // profile's "avoid" rules. Deterministic and cheap; failures are silent.
  useEffect(() => {
    if (!preview.trim()) {
      setLintTerms([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await backendFetch(`/voice/lint`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: preview }),
        });
        if (!res.ok) return;
        const j = (await res.json()) as { violations?: Array<{ term: string }> };
        setLintTerms((j.violations ?? []).map((v) => v.term));
      } catch {
        /* lint is best-effort */
      }
    }, 500);
    return () => clearTimeout(id);
  }, [preview]);

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
  // Streams over a Port so tokens render as they arrive. Resolves when the
  // stream completes (or errors), so callers that `await analyze(...)` still work.
  const analyze = useCallback(
    (mode: Mode, opts?: { steerOverride?: string; variationOf?: string }) =>
      new Promise<void>((resolve) => {
        // A variation is a SECOND draft rendered beside the one already on
        // screen, so it must not touch the primary draft's state: no clearing
        // the preview, the feedback marks, or the explain panel, and its own
        // spinner rather than the shared loading status (which would grey out
        // the mode buttons and make the first draft look like it was replaced).
        const isVariation = !!opts?.variationOf;
        setWaitedSec(null);
        if (isVariation) {
          setVariantLoading(true);
          setVariant("");
        } else {
          setStatus({ kind: "loading", mode });
          setCopied(false);
          setMemorySaved(false);
          setFeedbackGiven(null);
          setShowFeedbackNote(false);
          setExplain(null);
          setVariant(null);
        }
        const seed_text = mode === "shorter" || mode === "longer" ? preview : undefined;
        const steerVal = (opts?.steerOverride ?? steer).trim() || undefined;

        let port: chrome.runtime.Port;
        try {
          port = chrome.runtime.connect({ name: ANALYZE_STREAM_PORT });
        } catch (err) {
          setStatus({ kind: "error", message: (err as Error).message });
          resolve();
          return;
        }

        let acc = "";
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          setWaitedSec(null);
          try {
            port.disconnect();
          } catch {
            /* already gone */
          }
          resolve();
        };

        // After a reply lands, refresh the thread/contact panel (same as before).
        const refreshThread = async () => {
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
        };

        port.onMessage.addListener((ev: AnalyzeStreamEvent) => {
          if (ev.type === "ping") {
            // Liveness only — the model hasn't produced anything yet. Surfacing
            // the elapsed time is the difference between "slow" and "broken".
            setWaitedSec(Math.round(ev.waitedMs / 1000));
            setBackendHealth("online");
            return;
          }
          if (ev.type === "token") {
            acc += ev.t;
            setWaitedSec(null);
            if (isVariation) setVariant(acc);
            else setPreview(acc);
            setBackendHealth("online");
          } else if (ev.type === "reply_done") {
            acc = ev.suggested_reply ?? acc;
            if (isVariation) {
              setVariant(acc);
            } else {
              setPreview(acc);
              originalSuggestionRef.current = acc; // baseline for edit-mining
              const ex = (ev.stats as { explain?: typeof explain } | undefined)?.explain;
              setExplain(ex ?? null);
            }
            setBackendHealth("online");
          } else if (ev.type === "insight") {
            // A variation is a rewrite of a draft we already ran insight on —
            // re-proposing the same memory note would just churn the card.
            if (!isVariation) {
              setMemoryProposal(ev.memory_proposal ?? null);
              setStrategy(ev.strategy ?? null);
            }
          } else if (ev.type === "error") {
            if (isVariation) {
              setVariantLoading(false);
              setVariant(null);
            }
            setStatus({ kind: "error", message: ev.message });
            if (/fetch|backend|ECONN|network/i.test(ev.message)) void refreshHealth();
            finish();
          } else if (ev.type === "done") {
            if (isVariation) {
              setVariantLoading(false);
              finish();
              return;
            }
            void refreshThread().finally(() => {
              setStatus({ kind: "idle" });
              finish();
            });
          }
        });

        port.onDisconnect.addListener(() => {
          // Closed before an explicit done/error: treat a partial reply as success,
          // otherwise surface a disconnect.
          if (settled) return;
          if (isVariation) {
            setVariantLoading(false);
            if (!acc) setVariant(null);
          } else {
            setStatus(acc ? { kind: "idle" } : { kind: "error", message: "stream disconnected" });
          }
          finish();
        });

        port.postMessage({
          type: "ANALYZE_REQUEST",
          mode,
          seed_text,
          steer: steerVal,
          variation_of: opts?.variationOf,
        } satisfies AnalyzeRequest);
      }),
    [preview, refreshHealth, steer],
  );

  /**
   * "Another take": a second draft rendered BESIDE the first, not over it.
   *
   * Deliberately on demand rather than drafting two up front — the streaming
   * first draft is the fastest thing the product does, and speculatively paying
   * for a second LLM call on every Suggest would halve that for a choice the
   * user usually doesn't need.
   */
  const anotherTake = useCallback(() => {
    if (!preview.trim()) return;
    void analyze(coldOpen ? "cold_open" : "suggest", {
      steerOverride: (coldOpen ? intent : steer).trim() || undefined,
      variationOf: preview,
    });
  }, [analyze, preview, steer, intent, coldOpen]);

  /**
   * Choosing between the two drafts IS a preference signal, so the pick is
   * recorded as an implicit 👍 on the winner through the existing feedback
   * route — no new endpoint, and it feeds the same voice-correction loop as the
   * explicit thumbs.
   */
  const chooseDraft = useCallback(
    async (winner: "original" | "variant") => {
      const text = winner === "variant" ? variant : preview;
      if (!text) return;
      if (winner === "variant") {
        setPreview(text);
        originalSuggestionRef.current = text; // new edit-mining baseline
      }
      setVariant(null);
      setFeedbackGiven("up");
      await postFeedback({
        rating: "up",
        contact: coldOpen?.contactName || threadInfo?.title,
        suggestion: text,
        note: "Picked over an alternative draft.",
      });
    },
    [variant, preview, coldOpen, threadInfo],
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

  // Cold-open: draft a first message from the profile + the user's intent
  // (carried as the trusted steer). Intent is required by the button below.
  const draftIntro = useCallback(() => {
    void analyze("cold_open", { steerOverride: intent.trim() || undefined });
  }, [analyze, intent]);

  const regenerateIntro = useCallback(() => {
    const base = intent.trim() ? intent.trim() + ". " : "";
    void analyze("cold_open", {
      steerOverride:
        base + "Give a noticeably different opener — change the angle and the opening line.",
    });
  }, [analyze, intent]);

  const copyPreview = useCallback(async () => {
    if (!preview) return;
    await navigator.clipboard.writeText(preview);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);

    // Edit-mining (opt-in): if the user changed the suggestion before copying,
    // capture the diff as a candidate correction. Skip trivial whitespace-only
    // edits; the backend also rejects an identical before/after.
    const original = originalSuggestionRef.current;
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    if (editMiningRef.current && original && preview.trim() && norm(original) !== norm(preview)) {
      void backendFetch(`/voice/edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          before: original,
          after: preview,
          contact: coldOpen?.contactName || threadInfo?.title,
        }),
      }).catch(() => {});
    }
  }, [preview, coldOpen, threadInfo]);

  /**
   * Open the "add to my corpus" panel, prefilled from the live thread.
   *
   * Prefills the last thing I sent and the reply that followed it — the corpus
   * is a record of exchanges that WORKED, so an unanswered message isn't one.
   * The user edits both boxes before anything is written; that review is what
   * lets prompt.ts keep these examples outside the untrusted boundary.
   */
  const openCorpusPanel = useCallback(async () => {
    setCorpusStatus("");
    const resp = await sendBackground({ type: "STATUS_REQUEST" });
    const ctx = resp?.type === "STATUS_RESPONSE" ? resp.lastContext : null;
    const messages = ctx?.messages ?? [];
    const lastMineIdx = messages.map((m) => m.isSelf).lastIndexOf(true);
    const reply = lastMineIdx >= 0 ? messages.slice(lastMineIdx + 1).find((m) => !m.isSelf) : undefined;
    if (lastMineIdx < 0 || !reply) {
      setCorpusStatus("No reply to one of your messages in this thread yet.");
      return;
    }
    setCorpusDraft({
      contact: ctx?.conversation_title ?? threadInfo?.title ?? "",
      mine: messages[lastMineIdx].text,
      theirs: reply.text,
      tag: "",
    });
  }, [threadInfo]);

  const saveToCorpus = useCallback(async () => {
    if (!corpusDraft) return;
    setCorpusStatus("Saving…");
    try {
      const res = await backendFetch(`/corpus/exchanges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact: corpusDraft.contact,
          turns: [
            { isSelf: true, text: corpusDraft.mine },
            { isSelf: false, text: corpusDraft.theirs },
          ],
          tag: corpusDraft.tag || undefined,
          platform: window.location.hostname.includes("mail.google.com") ? "gmail" : "linkedin",
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `backend ${res.status}`);
      setCorpusDraft(null);
      setCorpusStatus("Added to your corpus ✓");
    } catch (err) {
      setCorpusStatus((err as Error).message);
    }
  }, [corpusDraft]);

  const feedbackContact = coldOpen?.contactName || threadInfo?.title;

  const onThumbUp = async () => {
    setFeedbackGiven("up");
    await postFeedback({ rating: "up", contact: feedbackContact, suggestion: preview });
  };

  const onThumbDown = () => {
    setShowFeedbackNote(true);
  };

  // A chip is the fast path: route the 👎 to a specific voice section and send.
  const submitChip = async (chip: { section: string; note: string }) => {
    setFeedbackGiven("down");
    setShowFeedbackNote(false);
    await postFeedback({
      rating: "down",
      section: chip.section,
      note: chip.note,
      contact: feedbackContact,
      suggestion: preview,
    });
  };

  const submitThumbDown = async () => {
    setFeedbackGiven("down");
    setShowFeedbackNote(false);
    await postFeedback({
      rating: "down",
      note: feedbackNote.trim() || undefined,
      contact: feedbackContact,
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
          if (coldOpen) draftIntro();
          else void analyze("suggest");
          return;
        case "f":
          if (coldOpen) return;
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
  }, [analyze, copyPreview, regenerate, preview, coldOpen, draftIntro]);

  const loadingMode = status.kind === "loading" ? status.mode : null;
  const isLoading = status.kind === "loading";
  const followupChip = renderFollowupChip(contactInfo);
  const armedSnap = getArmedSnapshot();
  const anomalyList = armedSnap?.diagnostics?.anomalies ?? [];
  const layoutBroken = hasLayoutAnomaly(anomalyList);
  const anomalyPlatform = armedSnap?.parsedContext?.platform;
  const anomalyPlatformLabel =
    anomalyPlatform === "gmail" ? "Gmail" : anomalyPlatform === "linkedin" ? "LinkedIn" : "";
  const anomalyReasons = anomalyList.map(describeAnomaly).join("; ");

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
              <span>⚠ Backend offline</span>
              <span className="ca-spacer" />
              <button onClick={() => void refreshHealth()} className="ca-retry">
                Retry
              </button>
            </div>
          )}

          {coldOpen && (
            <>
              <div className="ca-status">
                <span className="ca-muted">First message to</span>{" "}
                <strong>{coldOpen.contactName || "this person"}</strong>
              </div>

              <div className="ca-memory">
                <div className="ca-card-title">What's this about?</div>
                <input
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  placeholder="e.g. recruiting for a backend role, loved your talk on…"
                  className="ca-input"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && intent.trim()) {
                      e.preventDefault();
                      draftIntro();
                    }
                  }}
                />
                <div className="ca-row">
                  <ActionButton
                    label="Draft intro"
                    shortcut="Alt+S"
                    onClick={draftIntro}
                    loading={loadingMode === "cold_open"}
                    disabled={!intent.trim()}
                  />
                </div>
              </div>

              <textarea
                ref={previewRef}
                value={preview}
                onChange={(e) => setPreview(e.target.value)}
                placeholder="Your first message will appear here. Edit before copying."
                className="ca-preview"
                rows={6}
              />

              {waitedSec !== null && (
                <div className="ca-waiting">
                  Still writing — {waitedSec}s. Some providers take a while before the first word.
                </div>
              )}

              {lintTerms.length > 0 && status.kind !== "loading" && (
                <div className="ca-lint" title="From your own 'avoid' list in your voice profile">
                  ⚠ You usually avoid: {lintTerms.map((t) => `“${t}”`).join(", ")}
                </div>
              )}

              {explain && (explain.context_items.length > 0 || explain.notes_used > 0) && status.kind !== "loading" && (
                <details className="ca-explain">
                  <summary>Why this draft?</summary>
                  <div className="ca-explain-body">
                    {explain.context_items.length > 0 && (
                      <div>
                        <span className="ca-muted">About you:</span>{" "}
                        {explain.context_items.map((c) => c.title).join(", ")}
                      </div>
                    )}
                    {explain.notes_used > 0 && (
                      <div>
                        <span className="ca-muted">Notes on this contact:</span> {explain.notes_used}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {preview && status.kind !== "loading" && (
                <div className="ca-feedback">
                  {feedbackGiven ? (
                    <span className="ca-ok">Thanks — noted for your next profile refresh.</span>
                  ) : showFeedbackNote ? (
                    <div className="ca-feedback-note">
                      <div className="ca-fb-chips">
                        {DOWN_CHIPS.map((c) => (
                          <button
                            key={c.section}
                            onClick={() => submitChip(c)}
                            className="ca-chip"
                            title={c.note}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                      <div className="ca-fb-other">
                        <input
                          value={feedbackNote}
                          onChange={(e) => setFeedbackNote(e.target.value)}
                          placeholder="Other — what was off? (optional)"
                          className="ca-input"
                        />
                        <button onClick={submitThumbDown} className="ca-btn ca-btn-primary">
                          Send
                        </button>
                      </div>
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
                <button onClick={regenerateIntro} disabled={!preview || isLoading} className="ca-btn ca-btn-ghost" title="Regenerate (Alt+R)">
                  ↻ Regenerate
                </button>
                <button onClick={() => setPreview("")} disabled={!preview} className="ca-btn ca-btn-ghost">
                  Clear
                </button>
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

              {backendHealth === "online" && !health?.voiceProfileOk && (
                <div className="ca-strategy">
                  💡 Add your voice profile (see SETUP.md → <code>npm run init-voice</code>) so this sounds like you.
                </div>
              )}

              {status.kind === "error" && <div className="ca-error">{status.message}</div>}
            </>
          )}

          {!coldOpen && (
          <>
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
                    placeholder="Your display name"
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
              <div className="ca-card-title">
                {layoutBroken
                  ? `⚠ Couldn't read this ${anomalyPlatformLabel ? anomalyPlatformLabel + " " : ""}page`
                  : "⚠ Heads up"}
              </div>
              <div className="ca-anomaly-sub">
                {layoutBroken
                  ? "Its layout may have changed. Save a snapshot so it can be fixed."
                  : anomalyReasons || "see snapshot"}
              </div>
              {layoutBroken && anomalyReasons && <div className="ca-anomaly-sub">{anomalyReasons}.</div>}
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
              <span className="ca-muted">Open a conversation, then click Suggest.</span>
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

          {waitedSec !== null && (
            <div className="ca-waiting">
              Still writing — {waitedSec}s. Some providers take a while before the first word.
            </div>
          )}

          {lintTerms.length > 0 && status.kind !== "loading" && (
            <div className="ca-lint" title="From your own 'avoid' list in your voice profile">
              ⚠ You usually avoid: {lintTerms.map((t) => `“${t}”`).join(", ")}
            </div>
          )}

          {explain && (explain.context_items.length > 0 || explain.notes_used > 0) && status.kind !== "loading" && (
            <details className="ca-explain">
              <summary>Why this draft?</summary>
              <div className="ca-explain-body">
                {explain.context_items.length > 0 && (
                  <div>
                    <span className="ca-muted">About you:</span>{" "}
                    {explain.context_items.map((c) => c.title).join(", ")}
                  </div>
                )}
                {explain.notes_used > 0 && (
                  <div>
                    <span className="ca-muted">Notes on this contact:</span> {explain.notes_used}
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Feedback on the current suggestion */}
          {preview && status.kind !== "loading" && (
            <div className="ca-feedback">
              {feedbackGiven ? (
                <span className="ca-ok">Thanks — noted for your next profile refresh.</span>
              ) : showFeedbackNote ? (
                <div className="ca-feedback-note">
                  <div className="ca-fb-chips">
                    {DOWN_CHIPS.map((c) => (
                      <button
                        key={c.section}
                        onClick={() => submitChip(c)}
                        className="ca-chip"
                        title={c.note}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <div className="ca-fb-other">
                    <input
                      value={feedbackNote}
                      onChange={(e) => setFeedbackNote(e.target.value)}
                      placeholder="Other — what was off? (optional)"
                      className="ca-input"
                    />
                    <button onClick={submitThumbDown} className="ca-btn ca-btn-primary">
                      Send
                    </button>
                  </div>
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

          {!coldOpen && (
            <div className="ca-row">
              <button
                onClick={() => void openCorpusPanel()}
                disabled={!threadInfo}
                className="ca-btn ca-btn-ghost"
                title="Save this exchange as an example of how you write"
              >
                ＋ Add to my corpus
              </button>
              {corpusStatus && <span className="ca-muted">{corpusStatus}</span>}
            </div>
          )}

          {corpusDraft && (
            <div className="ca-variant">
              <div className="ca-variant-head">
                Add to my corpus — check this before it's saved
              </div>
              <span className="ca-muted">What I sent</span>
              <textarea
                value={corpusDraft.mine}
                onChange={(e) => setCorpusDraft({ ...corpusDraft, mine: e.target.value })}
                className="ca-preview"
                rows={4}
              />
              <span className="ca-muted">What {corpusDraft.contact || "they"} replied</span>
              <textarea
                value={corpusDraft.theirs}
                onChange={(e) => setCorpusDraft({ ...corpusDraft, theirs: e.target.value })}
                className="ca-preview"
                rows={3}
              />
              <input
                type="text"
                value={corpusDraft.tag}
                onChange={(e) => setCorpusDraft({ ...corpusDraft, tag: e.target.value })}
                placeholder="optional tag, e.g. crypto template — groups the reply-rate stats"
                className="ca-input"
              />
              <div className="ca-row">
                <button
                  onClick={() => void saveToCorpus()}
                  disabled={!corpusDraft.mine.trim()}
                  className="ca-btn ca-btn-primary"
                >
                  Add
                </button>
                <button onClick={() => setCorpusDraft(null)} className="ca-btn ca-btn-ghost">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {variant !== null && (
            <div className="ca-variant">
              <div className="ca-variant-head">
                {variantLoading ? "Another take — writing…" : "Another take"}
              </div>
              <textarea
                value={variant}
                onChange={(e) => setVariant(e.target.value)}
                placeholder="An alternative will appear here."
                className="ca-preview"
                rows={6}
              />
              <div className="ca-row">
                <button
                  onClick={() => void chooseDraft("variant")}
                  disabled={!variant.trim() || variantLoading}
                  className="ca-btn ca-btn-primary"
                  title="Use this one — recorded as a 👍"
                >
                  Use this one
                </button>
                <button
                  onClick={() => void chooseDraft("original")}
                  disabled={variantLoading}
                  className="ca-btn ca-btn-ghost"
                  title="Keep the first draft — recorded as a 👍 on it"
                >
                  Keep the first
                </button>
                <button onClick={() => setVariant(null)} className="ca-btn ca-btn-ghost">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="ca-row">
            <button onClick={copyPreview} disabled={!preview} className="ca-btn ca-btn-primary" title="Copy (Alt+C)">
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button onClick={regenerate} disabled={!preview || isLoading} className="ca-btn ca-btn-ghost" title="Regenerate (Alt+R)">
              ↻ Regenerate
            </button>
            <button
              onClick={anotherTake}
              disabled={!preview || isLoading || variantLoading || variant !== null}
              className="ca-btn ca-btn-ghost"
              title="Draft a second version beside this one, then pick"
            >
              ⇄ Another take
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
