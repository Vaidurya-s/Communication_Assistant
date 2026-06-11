/**
 * Gmail platform extractor — a thin adapter over `content/gmail.ts`, mirroring
 * `platforms/linkedin.ts`. Gmail has no LinkedIn-style profile page, so the
 * profile methods are inert (never reached: `isProfileUrl` is always false).
 */
import { GMAIL_URLS } from "./urls";
import type { PlatformExtractor } from "./types";
import {
  backfillMessages,
  extractGmailContext,
  getGmailSubtreeHtml,
  installMessageObserver,
} from "../content/gmail";

export const gmailExtractor: PlatformExtractor = {
  platform: "gmail",
  isMessagingUrl: GMAIL_URLS.isMessagingUrl,
  isProfileUrl: GMAIL_URLS.isProfileUrl,
  extractContext: extractGmailContext,
  backfillMessages,
  installMessageObserver,
  getCaptureHtml: getGmailSubtreeHtml,
  getContactProfileUrl: () => null,
  waitForProfileReady: async () => false,
  extractProfile: () => {
    throw new Error("gmail has no profile page");
  },
};
