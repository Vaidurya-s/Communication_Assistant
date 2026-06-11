# README images

Visual assets referenced by the project `README.md`.

## Extension overlay (real CSS, dark redesign)

| File | Shows | In README? |
|------|-------|------------|
| `overlay-demo.png`  | Populated panel — suggestion, tone steers, strategy tip, memory card | ✅ Overlay section |
| `overlay-panel.png` | First-run checklist + reply controls | ✅ Overlay section |

These two render the **redesigned dark overlay's real stylesheet**
(`extension/src/overlay/overlay-css.ts`) with fictional data ("Maya Chen"),
captured headless from `explanation/_preview/{demo,panel}.html` (a local,
gitignored harness):
`chrome --headless --force-device-scale-factor=2 --screenshot=docs/images/overlay-demo.png explanation/_preview/demo.html`.

| Legacy (old light theme) | Shows | In README? |
|------|-------|------------|
| `overlay-empty.png` · `overlay-shorter.png` · `overlay-longer.png` · `overlay-saved.png` | Earlier light-theme mockups ("Alex Morgan / Vertex Robotics") from `explanation/mockups/linkedin-demo.html` | spare / superseded |

## Dashboard / console (real UI, demo data)

| File | Shows | In README? |
|------|-------|------------|
| `dashboard-overview.png`  | Overview — metric cards + setup checklist | ✅ Dashboard section |
| `dashboard-contacts.png`  | Contacts — enriched profile + notes | ✅ Dashboard section |
| `dashboard-followups.png` | Follow-ups — Google Calendar / .ics export | ✅ Dashboard section |
| `dashboard-voice.png`     | Voice profile + feedback history | ✅ Dashboard section |
| `dashboard-settings.png`  | Settings — live LLM provider switch | ✅ Dashboard section |
| `dashboard-activity.png`  | Activity — strategy-read timeline | spare |

These are **real screenshots of the running dashboard**, captured with headless
Chrome against a **fictional seeded dataset** (Maya Chen, Devin Okoro, …) — so they
show the actual product while exposing no real contact, message, or key.

Regenerate: seed demo data (`backend/scripts/seed-demo.mjs`) into a throwaway DB,
start the backend, then capture each section by URL hash, e.g.
`chrome --headless --screenshot=docs/images/dashboard-voice.png "http://localhost:8000/#voice"`.

## Privacy

If you ever add real screenshots, redact every real name, face, and API key
first — everything in this folder is public.
