export interface LLMResult {
  text: string;
  stderr: string;
  durationMs: number;
}

export interface LLMRunOptions {
  /**
   * Tenant whose isolated gemini sandbox should be the run's cwd. Defaults to
   * the local tenant. Providers without a filesystem sandbox (openai-compat)
   * ignore it.
   */
  tenantId?: string;
  /**
   * The cacheable, byte-stable voice-profile prefix. When present, a caching
   * provider (anthropic) puts it in a `cache_control` system block and treats
   * `context` as the variable remainder placed after the breakpoint. Providers
   * without prompt caching ignore it.
   */
  staticPrefix?: string;
}

export interface LLMProvider {
  readonly name: string;
  run(instruction: string, context: string, opts?: LLMRunOptions): Promise<LLMResult>;
  /**
   * Optional streaming variant. Providers opt in by implementing it; callers
   * must feature-detect (`provider.runStream?.(...)`) and fall back to `run`.
   * `onToken` fires once per text delta as the draft generates; the resolved
   * LLMResult carries the full assembled text (same shape as `run`).
   */
  runStream?(
    instruction: string,
    context: string,
    opts?: LLMRunOptions & { onToken?: (t: string) => void },
  ): Promise<LLMResult>;
}
