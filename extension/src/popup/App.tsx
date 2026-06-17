import { useEffect, useState } from "react";
import { getSelfNameSetting, setSelfNameSetting } from "../shared/storage";
import {
  getBackendSettings,
  setBackendSettings,
  originMatchPattern,
  isDefaultOrigin,
  DEFAULT_ORIGIN,
} from "../shared/clientConfig";
import { isSupportedMessagingUrl, isProfileUrl } from "../platforms/urls";

export function App() {
  const [selfName, setSelfName] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [activeTabUrl, setActiveTabUrl] = useState<string>("");
  const [openStatus, setOpenStatus] = useState<string>("");

  const [backendOrigin, setBackendOrigin] = useState<string>(DEFAULT_ORIGIN);
  const [backendToken, setBackendToken] = useState<string>("");
  const [backendSaved, setBackendSaved] = useState(false);
  const [backendStatus, setBackendStatus] = useState<string>("");

  // Import the user's own LinkedIn profile into the "About me" context store.
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<string>("");
  const [importError, setImportError] = useState<string>("");

  // Compose a first message by profile URL (works from anywhere).
  const [composeUrl, setComposeUrl] = useState<string>("");
  const [composeIntent, setComposeIntent] = useState<string>("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeReply, setComposeReply] = useState<string>("");
  const [composeError, setComposeError] = useState<string>("");
  const [composeCopied, setComposeCopied] = useState(false);

  useEffect(() => {
    getSelfNameSetting().then(setSelfName);
    getBackendSettings().then((s) => {
      setBackendOrigin(s.origin);
      setBackendToken(s.token);
    });
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      const url = tab?.url ?? "";
      setActiveTabUrl(url);
      // If the user is already on a profile page, prefill the compose URL.
      if (url && isProfileUrl(url)) setComposeUrl(url);
    });
  }, []);

  const onCompose = async () => {
    setComposeError("");
    setComposeReply("");
    setComposeBusy(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "COMPOSE_INTRO",
        profileUrl: composeUrl.trim(),
        intent: composeIntent.trim(),
      });
      if (resp?.type === "BACKEND_RESPONSE") {
        setComposeReply(resp.payload?.suggested_reply ?? "");
      } else {
        setComposeError(resp?.message ?? "couldn't draft a message");
      }
    } catch (e) {
      setComposeError((e as Error).message);
    } finally {
      setComposeBusy(false);
    }
  };

  const onImportSelf = async () => {
    setImportError("");
    setImportResult("");
    setImportBusy(true);
    try {
      const resp = await chrome.runtime.sendMessage({ type: "IMPORT_SELF_PROFILE" });
      if (resp?.type === "IMPORT_RESULT") {
        const n = resp.payload?.created ?? 0;
        setImportResult(`Imported ${n} items — confirm them in the dashboard's About-me tab`);
      } else {
        setImportError(resp?.message ?? "couldn't import this profile");
      }
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  const copyCompose = async () => {
    if (!composeReply) return;
    await navigator.clipboard.writeText(composeReply);
    setComposeCopied(true);
    setTimeout(() => setComposeCopied(false), 1200);
  };

  const onSave = async () => {
    await setSelfNameSetting(selfName);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const onSaveBackend = async () => {
    const origin = backendOrigin.trim();
    setBackendStatus("");
    // A non-localhost origin needs host permission before the content script /
    // worker may call it. Request it from this user gesture (the Save click).
    if (origin && !isDefaultOrigin(origin)) {
      try {
        const granted = await chrome.permissions.request({ origins: [originMatchPattern(origin)] });
        if (!granted) {
          setBackendStatus("Permission denied for that origin — not saved.");
          return;
        }
      } catch (e) {
        setBackendStatus((e as Error).message);
        return;
      }
    }
    await setBackendSettings({ origin, token: backendToken });
    setBackendSaved(true);
    setTimeout(() => setBackendSaved(false), 1200);
  };

  const openPanel = async () => {
    setOpenStatus("Opening…");
    try {
      const resp = await chrome.runtime.sendMessage({ type: "OPEN_OVERLAY" });
      if (resp?.type === "OVERLAY_OPENED") {
        window.close(); // close the popup so the panel is visible on the page
      } else {
        setOpenStatus(resp?.message ?? "Couldn't open the panel here.");
      }
    } catch (e) {
      setOpenStatus((e as Error).message);
    }
  };

  const onSupported = isSupportedMessagingUrl(activeTabUrl);
  const onProfilePage = isProfileUrl(activeTabUrl);

  return (
    <div>
      <div className="pop-head">
        <span className="pop-brand" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M4 6.5C4 5.12 5.12 4 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <circle cx="9" cy="10" r="1" fill="currentColor" />
            <circle cx="12.5" cy="10" r="1" fill="currentColor" />
            <circle cx="16" cy="10" r="1" fill="currentColor" />
          </svg>
        </span>
        <div>
          <div className="pop-kicker">Settings</div>
          <h1 className="pop-title">Comms Assistant</h1>
        </div>
      </div>

      <p className="pop-desc">
        The assistant is a floating panel inside your messages on supported sites. It usually
        appears on its own — use the button below to bring it up if it didn't.
      </p>

      <button onClick={openPanel} className="pop-btn pop-btn-block">
        Open the panel
      </button>
      {openStatus && <div className="pop-substatus">{openStatus}</div>}

      <hr className="pop-divider" />

      <label className="pop-label">
        Import my LinkedIn into About-me <span className="pop-hint">(your own profile)</span>
      </label>
      {onProfilePage ? (
        <>
          <button
            onClick={onImportSelf}
            disabled={importBusy}
            className="pop-btn pop-btn-block"
          >
            {importBusy ? "Importing…" : "Import this profile"}
          </button>
          {importResult && <div className="pop-substatus">{importResult}</div>}
          {importError && <div className="pop-substatus">{importError}</div>}
        </>
      ) : (
        <div className="pop-substatus">
          Open your own LinkedIn profile, then click here.
        </div>
      )}

      <hr className="pop-divider" />

      <label className="pop-label">
        Draft a first message <span className="pop-hint">(someone you haven't messaged)</span>
      </label>
      <input
        type="text"
        value={composeUrl}
        onChange={(e) => setComposeUrl(e.target.value)}
        placeholder="https://www.linkedin.com/in/…"
        className="pop-input"
        style={{ width: "100%" }}
      />
      <input
        type="text"
        value={composeIntent}
        onChange={(e) => setComposeIntent(e.target.value)}
        placeholder="What's this about? e.g. recruiting for a backend role"
        className="pop-input"
        style={{ width: "100%", marginTop: 8 }}
      />
      <button
        onClick={onCompose}
        disabled={composeBusy || !composeUrl.trim() || !composeIntent.trim()}
        className="pop-btn pop-btn-block"
        style={{ marginTop: 8 }}
      >
        {composeBusy ? "Drafting…" : "Draft message"}
      </button>
      {composeError && <div className="pop-substatus">{composeError}</div>}
      {composeReply && (
        <>
          <textarea
            value={composeReply}
            onChange={(e) => setComposeReply(e.target.value)}
            className="pop-input"
            style={{ width: "100%", marginTop: 8, minHeight: 96, resize: "vertical" }}
          />
          <button onClick={copyCompose} className="pop-btn pop-btn-block" style={{ marginTop: 6 }}>
            {composeCopied ? "Copied ✓" : "Copy"}
          </button>
        </>
      )}

      <hr className="pop-divider" />

      <label className="pop-label">
        Your display name <span className="pop-hint">(for self-detection)</span>
      </label>
      <div className="pop-row">
        <input
          type="text"
          value={selfName}
          onChange={(e) => setSelfName(e.target.value)}
          placeholder="e.g. Vaidurya Shah"
          className="pop-input"
        />
        <button onClick={onSave} className="pop-btn">
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>

      <hr className="pop-divider" />

      <label className="pop-label">
        Backend URL <span className="pop-hint">(default: local)</span>
      </label>
      <input
        type="text"
        value={backendOrigin}
        onChange={(e) => setBackendOrigin(e.target.value)}
        placeholder={DEFAULT_ORIGIN}
        className="pop-input"
        style={{ width: "100%" }}
      />
      <label className="pop-label" style={{ marginTop: 10 }}>
        Access token <span className="pop-hint">(hosted backends only)</span>
      </label>
      <div className="pop-row">
        <input
          type="password"
          value={backendToken}
          onChange={(e) => setBackendToken(e.target.value)}
          placeholder="paste token if required"
          className="pop-input"
        />
        <button onClick={onSaveBackend} className="pop-btn">
          {backendSaved ? "Saved ✓" : "Save"}
        </button>
      </div>
      {backendStatus && <div className="pop-substatus">{backendStatus}</div>}

      <div className={`pop-status${onSupported ? " ok" : ""}`}>
        {onSupported ? (
          <>
            <span className="pop-dot" />
            Messaging detected — the overlay is live on the page.
          </>
        ) : (
          <span>
            Open LinkedIn or Gmail messaging to see the overlay.
          </span>
        )}
      </div>
    </div>
  );
}
