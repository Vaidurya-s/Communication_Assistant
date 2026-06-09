const KEY_DEBUG_MODE = "debugMode";

export async function getDebugMode(): Promise<boolean> {
  const all = await chrome.storage.local.get(KEY_DEBUG_MODE);
  return all[KEY_DEBUG_MODE] === true;
}

export async function setDebugMode(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY_DEBUG_MODE]: on });
}
