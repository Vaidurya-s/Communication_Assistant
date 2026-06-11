/**
 * Styles for the in-page overlay, injected into its Shadow DOM (see mount.ts).
 *
 * Aesthetic: "midnight instrument" — the same refined dark theme as the
 * dashboard. The overlay floats on LinkedIn's light page as a precise dark
 * control panel: hairline borders, accent glows, monospace readouts.
 *
 * The shadow root isolates this from LinkedIn (and vice-versa). Web fonts are
 * best-effort (LinkedIn's CSP may block the <link> mount.ts adds); the fallback
 * stack keeps the design cohesive regardless.
 */
export const OVERLAY_CSS = `
.ca-root {
  --bg: #0d1016;
  --panel: #12151c;
  --panel-2: #171b24;
  --raise: #1c212c;
  --border: #242a36;
  --hair: rgba(255,255,255,0.07);
  --text: #e8eaf1;
  --muted: #8b92a4;
  --faint: #5a6072;
  --accent: #5b9dff;
  --accent-2: #2f6fe0;
  --accent-soft: rgba(91,157,255,0.14);
  --accent-glow: rgba(91,157,255,0.40);
  --ok: #4cd08a;
  --ok-soft: rgba(76,208,138,0.14);
  --warn: #f5a73c;
  --warn-soft: rgba(245,167,60,0.14);
  --danger: #ff6b78;
  --danger-soft: rgba(255,107,120,0.14);
  --font: "Hanken Grotesk","Segoe UI",system-ui,-apple-system,sans-serif;
  --mono: "JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;

  position: fixed;
  width: 320px;
  box-sizing: border-box;
  background: linear-gradient(180deg, #14171f, var(--panel));
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 20px 48px -16px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.3);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
  letter-spacing: -0.005em;
  color: var(--text);
  overflow: hidden;
  z-index: 2147483647;
  animation: ca-in 0.28s cubic-bezier(0.2,0.8,0.2,1) both;
  -webkit-font-smoothing: antialiased;
}
.ca-root *, .ca-root *::before, .ca-root *::after { box-sizing: border-box; }

/* Header (drag handle) */
.ca-header {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 12px;
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  border-bottom: 1px solid var(--border);
  cursor: move; user-select: none;
}
.ca-title { font-weight: 700; font-size: 13px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
.ca-title::before {
  content: ""; width: 8px; height: 8px; border-radius: 50%;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  box-shadow: 0 0 8px var(--accent-glow);
}
.ca-spacer { flex: 1; }
.ca-icon-btn {
  background: transparent; border: none; color: var(--muted);
  font-size: 15px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}
.ca-icon-btn:hover { color: var(--text); background: var(--raise); }

/* Body */
.ca-body {
  padding: 12px; display: flex; flex-direction: column; gap: 9px;
  max-height: min(78vh, 660px); overflow-y: auto;
}

/* Text helpers */
.ca-muted { color: var(--muted); }
.ca-ok { color: var(--ok); }
.ca-card-title { font-weight: 700; font-size: 12.5px; }

/* Status line */
.ca-status { font-size: 12px; color: var(--muted); }
.ca-status strong { color: var(--text); font-weight: 600; }

/* Inputs */
.ca-input, .ca-preview {
  width: 100%; box-sizing: border-box;
  padding: 8px 10px; font-size: 12.5px; font-family: var(--font);
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px;
  color: var(--text); transition: border-color 0.15s, box-shadow 0.15s;
}
.ca-input::placeholder, .ca-preview::placeholder { color: var(--faint); }
.ca-input:focus, .ca-preview:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
}
.ca-preview { resize: vertical; min-height: 96px; line-height: 1.55; }
.ca-preview-sm { min-height: 44px; }

/* Buttons */
.ca-btn {
  padding: 8px 14px; border-radius: 9px; font: 600 12.5px var(--font);
  border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
  cursor: pointer; transition: transform 0.15s, background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s;
  white-space: nowrap;
}
.ca-btn:hover:not(:disabled) { transform: translateY(-1px); }
.ca-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ca-btn-primary { flex: 1; background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 8px 18px -10px var(--accent-glow); }
.ca-btn-primary:hover:not(:disabled) { background: var(--accent-2); }
.ca-btn-ghost { background: var(--panel-2); }
.ca-btn-ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.ca-btn-block { width: 100%; }

.ca-row { display: flex; gap: 6px; }

/* Action buttons (Suggest / Follow-up / Shorter / Longer) */
.ca-action {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px 10px; border-radius: 9px; font: 600 12.5px var(--font);
  border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
  cursor: pointer; transition: transform 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.ca-action:hover:not(:disabled) { transform: translateY(-1px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); box-shadow: 0 10px 22px -14px var(--accent-glow); }
.ca-action:disabled { opacity: 0.45; cursor: not-allowed; }

/* Tone chips */
.ca-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.ca-chip {
  padding: 4px 11px; font: 500 11.5px var(--font); border-radius: 999px;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  cursor: pointer; transition: 0.15s;
}
.ca-chip:hover:not(:disabled) { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.ca-chip:disabled { opacity: 0.45; cursor: not-allowed; }

/* Cards */
.ca-checklist {
  background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  padding: 11px; border-radius: 11px; font-size: 12px; display: flex; flex-direction: column; gap: 4px;
}
.ca-check { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.ca-check-ico { width: 16px; text-align: center; font-weight: 700; }
.ca-check-ico.is-ok { color: var(--ok); }
.ca-check-ico.is-todo { color: var(--warn); }
.ca-check-hint { color: var(--faint); font-size: 11px; }

.ca-followup {
  background: var(--warn-soft); border: 1px solid transparent; border-left: 3px solid var(--warn);
  padding: 8px 10px; border-radius: 9px; font-size: 11.5px; font-weight: 500; color: var(--text); cursor: pointer;
  transition: 0.15s;
}
.ca-followup:hover { background: color-mix(in srgb, var(--warn) 22%, transparent); }

.ca-strategy {
  background: var(--warn-soft); border: 1px solid transparent; border-left: 3px solid var(--warn);
  padding: 9px 11px; border-radius: 9px; font-size: 12px; color: var(--text);
}

.ca-memory {
  background: var(--ok-soft); border: 1px solid transparent; border-left: 3px solid var(--ok);
  padding: 11px; border-radius: 9px; font-size: 12px; display: flex; flex-direction: column; gap: 7px;
}
.ca-memory-note { color: var(--text); }

.ca-anomaly {
  background: var(--warn-soft); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  padding: 11px; border-radius: 9px; font-size: 12px; display: flex; flex-direction: column; gap: 6px;
}
.ca-anomaly-sub { font-size: 11px; color: var(--warn); }

.ca-error {
  background: var(--danger-soft); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  padding: 8px 10px; border-radius: 9px; font-size: 11px; white-space: pre-wrap; word-break: break-word;
}

.ca-offline {
  display: flex; align-items: center; gap: 6px;
  background: var(--danger-soft); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  padding: 8px 10px; border-radius: 9px; font-size: 11.5px; font-weight: 500;
}
.ca-retry {
  padding: 4px 11px; font: 600 11px var(--font); border-radius: 7px;
  border: 1px solid var(--danger); background: transparent; color: var(--danger); cursor: pointer; transition: 0.15s;
}
.ca-retry:hover { background: var(--danger-soft); }

/* Feedback */
.ca-feedback { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ca-feedback-note { display: flex; gap: 6px; width: 100%; }
.ca-thumb {
  border: 1px solid var(--border); background: var(--panel-2); border-radius: 8px;
  cursor: pointer; font-size: 14px; padding: 3px 9px; line-height: 1.2; transition: 0.15s;
}
.ca-thumb:hover { transform: translateY(-1px); border-color: var(--accent); }

/* Footer */
.ca-footer {
  display: flex; align-items: center; gap: 7px; margin-top: 2px; padding-top: 9px;
  border-top: 1px solid var(--hair); font-size: 10px; color: var(--faint);
}
.ca-foot-summary { font-family: var(--mono); font-size: 10px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ca-kbd { font-size: 12px; color: var(--muted); cursor: help; padding: 0 2px; }
.ca-foot-toggle {
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  font: 500 10px var(--mono); padding: 2px 7px; cursor: pointer; color: var(--muted); transition: 0.15s;
}
.ca-foot-toggle:hover { color: var(--text); border-color: var(--accent); }

.ca-diag {
  background: #07090d; color: #cdd6e4; padding: 10px; border-radius: 9px; border: 1px solid var(--border);
  font-family: var(--mono); font-size: 10px; max-height: 240px; overflow: auto; white-space: pre; margin: 0;
}

/* Spinner */
.ca-spinner {
  display: inline-block; width: 11px; height: 11px;
  border: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-top-color: var(--accent); border-radius: 50%;
  animation: commsasst-spin 0.7s linear infinite;
}

/* Scrollbars (within the shadow root) */
.ca-body::-webkit-scrollbar, .ca-diag::-webkit-scrollbar { width: 9px; height: 9px; }
.ca-body::-webkit-scrollbar-thumb, .ca-diag::-webkit-scrollbar-thumb { background: var(--border); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
.ca-body::-webkit-scrollbar-thumb:hover, .ca-diag::-webkit-scrollbar-thumb:hover { background: var(--faint); background-clip: padding-box; }

@keyframes commsasst-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes ca-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  .ca-root, .ca-btn, .ca-action, .ca-thumb { animation: none !important; transition: none !important; }
}
`;
