/**
 * Holds the extractor for the page the content script is currently on. Lets
 * modules like `snapshot.ts` reach the active extractor without importing
 * `content/index.ts` (which would create a circular dependency).
 */
import type { PlatformExtractor } from "../platforms/types";

let current: PlatformExtractor | null = null;

export function setCurrentExtractor(e: PlatformExtractor | null): void {
  current = e;
}

export function getCurrentExtractor(): PlatformExtractor | null {
  return current;
}
