import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env");

/**
 * Quote a value for .env if it contains characters that would otherwise be
 * mis-parsed (whitespace, `#`, or surrounding quotes). The loader in config.ts
 * strips matched surrounding quotes, so this round-trips cleanly.
 */
function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/[\s#'"]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Update backend/.env in place: rewrite existing KEY=VALUE lines, preserve
 * comments and blank lines, and append any keys that weren't present. Creates
 * the file if it doesn't exist.
 *
 * NOTE: this only persists settings across restarts. To take effect in the
 * running process, the caller must ALSO mutate process.env and bust the config
 * + provider caches — config.ts's loader only fills keys MISSING from
 * process.env, so a freshly-written .env value would otherwise be ignored.
 */
export function writeEnv(updates: Record<string, string>): void {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const remaining = new Set(keys);
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8").split(/\r?\n/) : [];

  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return line;
    const eq = t.indexOf("=");
    if (eq < 0) return line;
    const key = t.slice(0, eq).trim();
    if (remaining.has(key)) {
      remaining.delete(key);
      return `${key}=${quoteIfNeeded(updates[key])}`;
    }
    return line;
  });

  for (const key of keys) {
    if (remaining.has(key)) {
      out.push(`${key}=${quoteIfNeeded(updates[key])}`);
    }
  }

  // Avoid a leading blank line when creating a brand-new file.
  const body = out.join("\n").replace(/^\n+/, "");
  writeFileSync(ENV_PATH, body.endsWith("\n") ? body : body + "\n", "utf-8");
}
