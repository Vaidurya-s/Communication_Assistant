# Publishing the extension

How to package Comms Assistant and (optionally) put it on the Chrome Web Store.
The backend stays local — only the **extension** is distributed.

> Reminder: users still run the backend themselves. The store listing should
> say so clearly, and link to `SETUP.md`.

## 1. Build a clean production bundle

```bash
npm run build:extension      # outputs extension/dist
```

Verify `extension/dist/manifest.json` exists and the icons are present.

## 2. Package it as a zip

The Web Store wants a zip of the **contents** of `extension/dist` (not the
folder itself).

- **Windows (PowerShell):**
  ```powershell
  Compress-Archive -Path extension/dist/* -DestinationPath comms-assistant.zip -Force
  ```
- **macOS / Linux:**
  ```bash
  cd extension/dist && zip -r ../../comms-assistant.zip . && cd ../..
  ```

For a GitHub release (so non-developers can skip building), attach
`comms-assistant.zip` to a tagged release. Users would still need to unzip and
"Load unpacked," so the Web Store path below is friendlier.

## 3. Chrome Web Store submission

1. Create a developer account at the
   [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time fee).
2. **Upload** `comms-assistant.zip`.
3. **Listing assets** — you'll need:
   - Icon: `extension/icons/128.png` (already shipped).
   - At least one screenshot (1280×800 or 640×400). Use the clean, PII-free
     shots in `docs/images/` (`overlay-demo.png`, `overlay-panel.png`).
   - A short and detailed description (pull from `README.md`).
4. **Privacy** — link to `PRIVACY.md` (host it somewhere public, e.g. the repo).
   Complete the data-use disclosures: this extension collects **no** user data
   and uses permissions only for local functionality.
5. **Permission justifications** (reviewers ask for these):
   - `activeTab` + `linkedin.com` host — read the open conversation to draft a
     reply.
   - `localhost:8000` host — communicate with the user's own local backend.
   - `storage` — persist user settings locally.
   - `scripting` — render the in-page assistant panel.
6. **Submit for review.** First reviews can take a few days.

## 4. Versioning

Bump `version` in **both** `extension/manifest.json` and the root
`package.json` for each release, and tag it in git (e.g. `git tag v0.2.0`).

## Notes for reviewers / users

- The extension is non-functional without the companion local backend; this is
  by design (privacy — no cloud). Make sure the listing sets that expectation
  and links to setup instructions.
- No remote code is loaded; everything is bundled.
