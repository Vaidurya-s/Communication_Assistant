/**
 * LinkedIn platform extractor — a thin adapter over the existing LinkedIn
 * extraction functions. No extraction logic lives here; it delegates to
 * `content/linkedin.ts` and `content/profile.ts` so behaviour is identical to
 * before the abstraction. New platforms implement `PlatformExtractor` the same
 * way.
 */
import { LINKEDIN_URLS } from "./urls";
import type { PlatformExtractor } from "./types";
import {
  backfillMessages,
  extractLinkedInContext,
  getMessageListSubtreeHtml,
  installMessageObserver,
} from "../content/linkedin";
import {
  extractLinkedInProfile,
  getThreadContactProfileUrl,
  waitForProfileReady,
} from "../content/profile";

export const linkedinExtractor: PlatformExtractor = {
  platform: "linkedin",
  isMessagingUrl: LINKEDIN_URLS.isMessagingUrl,
  isProfileUrl: LINKEDIN_URLS.isProfileUrl,
  extractContext: extractLinkedInContext,
  backfillMessages,
  installMessageObserver,
  getCaptureHtml: getMessageListSubtreeHtml,
  getContactProfileUrl: getThreadContactProfileUrl,
  waitForProfileReady,
  extractProfile: extractLinkedInProfile,
};
