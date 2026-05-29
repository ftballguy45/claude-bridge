export interface CommandRequest {
  message: string;
  /**
   * Optional override for Claude's system prompt. When omitted, the Bridge
   * uses its baked-in DEFAULT_SYSTEM_PROMPT. Consumers (Dwell, the HA voice
   * integration, etc.) are expected to fetch their own prompt by name from
   * Dwell's `/api/ai/prompts` API and pass it here per-request.
   */
  systemPrompt?: string;
  /**
   * Optional override for which Claude model to invoke (e.g.
   * "claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"). When
   * omitted, the Bridge uses its baked-in default model. Letting consumers
   * pick per-request lets callers trade off latency vs capability per
   * use case — e.g. voice satellites prefer Haiku for snappier responses,
   * chat surfaces stick with Sonnet for deeper reasoning.
   */
  model?: string;
}

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
