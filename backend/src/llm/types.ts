export interface LLMResult {
  text: string;
  stderr: string;
  durationMs: number;
}

export interface LLMProvider {
  readonly name: string;
  run(instruction: string, context: string): Promise<LLMResult>;
}
