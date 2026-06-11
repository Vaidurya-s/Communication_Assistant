import { useEffect, useState } from "react";
import { getSelfNameSetting, setSelfNameSetting } from "../shared/storage";

export function App() {
  const [selfName, setSelfName] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [activeTabUrl, setActiveTabUrl] = useState<string>("");

  useEffect(() => {
    getSelfNameSetting().then(setSelfName);
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setActiveTabUrl(tab?.url ?? "");
    });
  }, []);

  const onSave = async () => {
    await setSelfNameSetting(selfName);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const onLinkedIn = activeTabUrl.includes("linkedin.com/messaging");

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
        The assistant lives as a floating panel inside LinkedIn messaging. This popup is
        just for settings.
      </p>

      <label className="pop-label">
        Your LinkedIn display name <span className="pop-hint">(for self-detection)</span>
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

      <div className={`pop-status${onLinkedIn ? " ok" : ""}`}>
        {onLinkedIn ? (
          <>
            <span className="pop-dot" />
            LinkedIn messaging detected — the overlay is live on the page.
          </>
        ) : (
          <span>
            Open <code>linkedin.com/messaging/</code> to see the overlay.
          </span>
        )}
      </div>
    </div>
  );
}
