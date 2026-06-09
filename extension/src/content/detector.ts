import type { Platform } from "../shared/types";
import { LINKEDIN_MESSAGING_PATH } from "./selectors";

export function detectPlatform(loc: Location): Platform {
  const host = loc.hostname;
  if (host.includes("linkedin.com")) return "linkedin";
  if (host.includes("web.whatsapp.com")) return "whatsapp";
  if (host.includes("mail.google.com")) return "gmail";
  return "unknown";
}

export function isLinkedInMessagingRoute(loc: Location): boolean {
  return loc.hostname.includes("linkedin.com") && loc.pathname.includes(LINKEDIN_MESSAGING_PATH);
}
