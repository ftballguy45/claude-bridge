export interface CommandRequest {
  message: string;
  /**
   * Optional override for Claude's system prompt. When omitted, the Bridge
   * uses its baked-in DEFAULT_SYSTEM_PROMPT. Consumers (Dwell, the HA voice
   * integration, etc.) are expected to fetch their own prompt by name from
   * Dwell's `/api/ai/prompts` API and pass it here per-request.
   */
  systemPrompt?: string;
}

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
