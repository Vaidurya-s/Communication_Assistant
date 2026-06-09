import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Overlay } from "./Overlay";

const HOST_ID = "comms-assistant-root";

interface MountedOverlay {
  host: HTMLDivElement;
  root: Root;
}

let mounted: MountedOverlay | null = null;

export function mountOverlay(): void {
  if (mounted) return;
  if (document.getElementById(HOST_ID)) return; // stale host left from a prior content-script run

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.all = "initial"; // isolate from inherited LinkedIn styles
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
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
