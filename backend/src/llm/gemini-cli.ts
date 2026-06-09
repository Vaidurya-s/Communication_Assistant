import { spawn } from "node:child_process";
import { getWorkspacePath } from "../workspace.js";
import type { LLMProvider, LLMResult } from "./types.js";

// On Windows the npm-installed gemini CLI is a .ps1/.cmd shim; on POSIX it's a
// shebang script. `shell: true` lets Node resolve whichever exists on PATH.
const GEMINI_BIN = "gemini";

/**
 * Run gemini in non-interactive mode.
 *
 * We pipe the entire prompt on stdin (no `-p` flag). When gemini detects piped
 * stdin and no -p, it treats stdin as the full prompt and runs headlessly.
 * This sidesteps Windows shell-quoting issues that bite when long prompts
 * containing spaces/newlines are passed as a `-p` argument under `shell: true`.
 */
export function createGeminiCliProvider(timeoutMs: number): LLMProvider {
  return {
    name: "gemini-cli",
    run(instruction: string, context: string): Promise<LLMResult> {
      return new Promise((resolvePromise, reject) => {
        const start = Date.now();
        const child = spawn(
          GEMINI_BIN,
          ["--approval-mode", "plan", "--skip-trust"],
          {
            shell: true,
            windowsHide: true,
            // cwd is the isolated sandbox built at server startup. gemini's
            // Read/Grep tools cannot see anything outside this directory.
            cwd: getWorkspacePath(),
          },
        );

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(new Error(`gemini timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf-8");
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf-8");
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`gemini exited ${code}: ${stderr.slice(0, 500)}`));
            return;
          }
          resolvePromise({
            text: cleanOutput(stdout),
            stderr,
            durationMs: Date.now() - start,
          });
        });

        const payload = `${context}\n\n=== TASK ===\n${instruction}\n`;
        child.stdin.write(payload);
        child.stdin.end();
      });
    },
  };
}

// Gemini CLI prints harmless warnings on stderr; if any leak in (older versions did), drop them.
function cleanOutput(s: string): string {
  return s
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (t.startsWith("Warning:")) return false;
      if (t.startsWith("Ripgrep is not available")) return false;
      return true;
    })
    .join("\n")
    .trim();
}
