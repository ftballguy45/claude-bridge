/**
 * Generic completion endpoint — what WorkflowBuilder (and any future
 * generic caller) uses.
 *
 * The HA-specific /api/command endpoint is SSE-streamed with tool use and
 * a baked-in system prompt. That's not what most consumers want. This
 * endpoint is dead-simple JSON in, JSON out:
 *
 *   POST /classify
 *   { systemPrompt, userMessage, model?, jsonSchema? }
 *   →  { text, durationMs }
 *
 * No tools. No MCP. No streaming. Matches the signature that the .NET-side
 * ClaudeBridgeChatClient already posts.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ClassifyRequest {
  systemPrompt?: string;
  userMessage: string;
  model?: string;
  jsonSchema?: unknown;
}

export interface ClassifyResponse {
  text: string;
  durationMs: number;
}

const DEFAULT_MODEL = "claude-haiku-4-5";

export async function runClassify(req: ClassifyRequest): Promise<ClassifyResponse> {
  if (!req.userMessage?.trim()) {
    throw new Error("userMessage is required");
  }

  const t0 = performance.now();

  // If the caller wants structured output, we append a brief instruction
  // and inlined schema so Claude returns strict JSON. The bridge doesn't
  // validate — that's the server's job (see JsonSchemaValidator).
  const systemPrompt = req.jsonSchema
    ? `${req.systemPrompt ?? ""}\n\nYou must respond with valid JSON matching this schema. ` +
      `Output ONLY the JSON — no prose, no code fences.\n\n` +
      `Schema:\n${JSON.stringify(req.jsonSchema, null, 2)}`
    : (req.systemPrompt ?? "");

  const options: Record<string, unknown> = {
    model: req.model ?? DEFAULT_MODEL,
    systemPrompt,
    maxTurns: 1, // no tool loop — we want a single completion
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };

  let text = "";

  try {
    const stream = query({ prompt: req.userMessage, options });
    for await (const event of stream) {
      if (event.type === "assistant") {
        const msg = (event as Record<string, unknown>).message as
          | { content?: Array<{ type: string; text?: string }> }
          | undefined;
        for (const block of msg?.content ?? []) {
          if (block.type === "text" && block.text) text += block.text;
        }
      } else if (event.type === "result") {
        // If the SDK surfaces a terminal error in the result event, throw
        // so the Express handler can return a 500 with the detail.
        const e = event as Record<string, unknown>;
        const subtype = e.subtype as string | undefined;
        if (subtype?.startsWith("error")) {
          throw new Error((e.result as string) || `Query ended with ${subtype}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`classify failed: ${msg}`);
  }

  return {
    text: text.trim(),
    durationMs: Math.round(performance.now() - t0),
  };
}
