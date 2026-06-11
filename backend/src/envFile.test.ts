import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEnv } from "./envFile.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comms-env-"));
  envPath = join(dir, ".env");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeEnv", () => {
  it("creates the file when absent and ends with a newline", () => {
    writeEnv({ FOO: "bar" }, envPath);
    const body = readFileSync(envPath, "utf-8");
    expect(body).toContain("FOO=bar");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("updates an existing key in place and preserves comments + other lines", () => {
    writeFileSync(envPath, "# a comment\nFOO=old\nBAR=keep\n", "utf-8");
    writeEnv({ FOO: "new" }, envPath);
    const body = readFileSync(envPath, "utf-8");
    expect(body).toContain("# a comment");
    expect(body).toContain("FOO=new");
    expect(body).not.toContain("FOO=old");
    expect(body).toContain("BAR=keep");
  });

  it("appends keys that weren't present", () => {
    writeFileSync(envPath, "FOO=1\n", "utf-8");
    writeEnv({ NEWKEY: "2" }, envPath);
    const body = readFileSync(envPath, "utf-8");
    expect(body).toContain("FOO=1");
    expect(body).toContain("NEWKEY=2");
  });

  it("quotes values containing spaces or #", () => {
    writeEnv({ K: "a b #c" }, envPath);
    expect(readFileSync(envPath, "utf-8")).toContain('K="a b #c"');
  });

  it("is a no-op for empty updates", () => {
    writeEnv({}, envPath);
    expect(existsSync(envPath)).toBe(false);
  });
});
