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
}

export interface LLMProvider {
  readonly name: string;
  run(instruction: string, context: string, opts?: LLMRunOptions): Promise<LLMResult>;
}
