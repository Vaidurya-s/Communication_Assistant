const KEY_SELF_NAME = "selfName";

export async function getSelfNameSetting(): Promise<string> {
  const all = await chrome.storage.sync.get(KEY_SELF_NAME);
  return (all[KEY_SELF_NAME] ?? "").toString().trim();
}

export async function setSelfNameSetting(name: string): Promise<void> {
  await chrome.storage.sync.set({ [KEY_SELF_NAME]: name.trim() });
}
