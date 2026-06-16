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

/** Cold-open (first-message) context, set when the overlay mounts on a profile page. */
export interface ColdOpenInfo {
  contactName: string;
}

export interface OverlayProps {
  coldOpen?: ColdOpenInfo | null;
}

let mounted: MountedOverlay | null = null;
let mountedColdOpen: boolean = false;

function renderOverlay(root: Root, props: OverlayProps): void {
  root.render(
    createElement(
      StrictMode,
      null,
      createElement(Overlay, { onClose: unmountOverlay, coldOpen: props.coldOpen ?? null }),
    ),
  );
}

export function mountOverlay(props: OverlayProps = {}): void {
  const isColdOpen = !!props.coldOpen;
  if (mounted) {
    // Already mounted. Re-render only if the variant changed (messaging ↔
    // cold-open) — e.g. an SPA navigation from a thread to a profile page.
    if (mountedColdOpen !== isColdOpen) {
      mountedColdOpen = isColdOpen;
      renderOverlay(mounted.root, props);
    }
    return;
  }
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
  renderOverlay(root, props);

  mounted = { host: host as HTMLDivElement, root };
  mountedColdOpen = isColdOpen;
}

export function unmountOverlay(): void {
  if (!mounted) return;
  mounted.root.unmount();
  mounted.host.remove();
  mounted = null;
  mountedColdOpen = false;
}
