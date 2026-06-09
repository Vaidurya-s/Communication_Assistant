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
      <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Comms Assistant — Settings</h2>

      <p style={{ margin: "0 0 8px", color: "#555", fontSize: 12 }}>
        The assistant lives as a floating panel inside LinkedIn messaging. This popup is
        only for settings.
      </p>

      <label style={{ display: "block", marginBottom: 4, color: "#555" }}>
        Your LinkedIn display name (for self-detection):
      </label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={selfName}
          onChange={(e) => setSelfName(e.target.value)}
          placeholder="e.g. Vaidurya Shah"
          style={{ flex: 1, padding: "4px 6px", fontSize: 12 }}
        />
        <button onClick={onSave} style={{ padding: "4px 8px", fontSize: 12 }}>
          {saved ? "Saved" : "Save"}
        </button>
      </div>

      <div style={{ marginTop: 12, padding: 8, background: "#f5f5f7", borderRadius: 4, fontSize: 12 }}>
        {onLinkedIn ? (
          <span style={{ color: "#15803d" }}>
            ✓ LinkedIn messaging tab detected — the overlay is mounted on the page.
          </span>
        ) : (
          <span style={{ color: "#555" }}>
            Open <code>linkedin.com/messaging/</code> to see the overlay.
          </span>
        )}
      </div>
    </div>
  );
}
