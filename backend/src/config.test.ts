import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reloadConfig } from "./config.js";

const KEYS = [
  "LLM_PROVIDER",
  "LLM_TIMEOUT_MS",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_TEMPERATURE",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  reloadConfig(); // restore the module cache for any other suite
});

describe("config.reloadConfig", () => {
  it("defaults to gemini-cli with sane fallbacks", () => {
    const cfg = reloadConfig();
    expect(cfg.provider).toBe("gemini-cli");
    expect(cfg.timeoutMs).toBe(180000);
    expect(cfg.openai.model).toBe("gpt-4o-mini");
  });

  it("switches provider and strips trailing slashes from the base URL", () => {
    process.env.LLM_PROVIDER = "openai-compat";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1///";
    process.env.OPENAI_API_KEY = "sk-test";
    const cfg = reloadConfig();
    expect(cfg.provider).toBe("openai-compat");
    expect(cfg.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.openai.apiKey).toBe("sk-test");
  });

  it("parses numeric env values", () => {
    process.env.LLM_TIMEOUT_MS = "5000";
    process.env.OPENAI_TEMPERATURE = "0.4";
    const cfg = reloadConfig();
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.openai.temperature).toBe(0.4);
  });
});
