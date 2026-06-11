import { describe, it, expect } from "vitest";
import {
  canonicalProfileUrl,
  isProfileFresh,
  PROFILE_CACHE_TTL_MS,
  type ContactProfile,
} from "./profile";

function profile(fetchedAt: string): ContactProfile {
  return {
    name: "", headline: "", role: "", company: "", location: "", about: "",
    experience: [], education: [], skills: [], profileUrl: "", fetchedAt,
  };
}

describe("canonicalProfileUrl", () => {
  it("strips query + fragment and ensures a trailing slash", () => {
    expect(canonicalProfileUrl("https://www.linkedin.com/in/maya-chen?foo=1#bar")).toBe(
      "https://www.linkedin.com/in/maya-chen/",
    );
    expect(canonicalProfileUrl("https://www.linkedin.com/in/maya-chen/")).toBe(
      "https://www.linkedin.com/in/maya-chen/",
    );
  });

  it("returns the input unchanged on an invalid URL", () => {
    expect(canonicalProfileUrl("not a url")).toBe("not a url");
  });
});

describe("isProfileFresh", () => {
  const now = Date.parse("2026-06-05T00:00:00.000Z");

  it("is fresh within the TTL", () => {
    expect(isProfileFresh(profile(new Date(now - 1000).toISOString()), now)).toBe(true);
  });

  it("is stale past the TTL", () => {
    expect(isProfileFresh(profile(new Date(now - PROFILE_CACHE_TTL_MS - 1000).toISOString()), now)).toBe(false);
  });

  it("is not fresh when fetchedAt is unparseable", () => {
    expect(isProfileFresh(profile("not-a-date"), now)).toBe(false);
  });
});
