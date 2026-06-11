import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Overlay } from "./Overlay";
import { OVERLAY_CSS } from "./overlay-css";

const HOST_ID = "comms-assistant-root";
const FONT_LINK_ID = "comms-assistant-fonts";

// Best-effort web-font load. Fonts are document-scoped, so a <link> in the page
// head reaches the shadow tree. LinkedIn's CSP may block it — that's fine, the
// CSS falls back to a refined system stack and the design stays cohesive.
function ensureFonts(): void {
  try {
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  } catch {
    /* CSP blocked or no head — fall back to system fonts */
  }
}

interface MountedOverlay {
  host: HTMLDivElement;
  root: Root;
}

let mounted: MountedOverlay | null = null;

export function mountOverlay(): void {
  if (mounted) return;
  if (document.getElementById(HOST_ID)) return; // stale host left from a prior content-script run

  ensureFonts();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.all = "initial"; // isolate from inherited LinkedIn styles
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  // The overlay's full stylesheet, scoped inside the shadow root so it can't
  // bleed into LinkedIn's page styles (and LinkedIn's can't bleed in).
  const styleEl = document.createElement("style");
  styleEl.textContent = OVERLAY_CSS;
  shadow.appendChild(styleEl);

  const reactContainer = document.createElement("div");
  shadow.appendChild(reactContainer);

  const root = createRoot(reactContainer);
  root.render(
    createElement(StrictMode, null, createElement(Overlay, { onClose: unmountOverlay })),
  );

  mounted = { host: host as HTMLDivElement, root };
}

export function unmountOverlay(): void {
  if (!mounted) return;
  mounted.root.unmount();
  mounted.host.remove();
  mounted = null;
}
