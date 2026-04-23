export interface CommandRequest {
  message: string;
}

export interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
