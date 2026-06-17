const KEY_SELF_NAME = "selfName";

export async function getSelfNameSetting(): Promise<string> {
  const all = await chrome.storage.sync.get(KEY_SELF_NAME);
  return (all[KEY_SELF_NAME] ?? "").toString().trim();
}

export async function setSelfNameSetting(name: string): Promise<void> {
  await chrome.storage.sync.set({ [KEY_SELF_NAME]: name.trim() });
}

// Edit-mining: when ON, the diff between a suggested draft and what the user
// actually copies (after editing) is captured as a candidate voice correction.
// OPT-IN (default off) — it's the user's own writing, kept on-device, and only
// sent to the local backend when explicitly enabled.
const KEY_EDIT_MINING = "editMining";

export async function getEditMiningSetting(): Promise<boolean> {
  const all = await chrome.storage.sync.get(KEY_EDIT_MINING);
  return all[KEY_EDIT_MINING] === true;
}

export async function setEditMiningSetting(on: boolean): Promise<void> {
  await chrome.storage.sync.set({ [KEY_EDIT_MINING]: on });
}
