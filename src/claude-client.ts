import { query } from "@anthropic-ai/claude-agent-sdk";

// Baked-in default system prompt. Used when a consumer does NOT pass an
// explicit `systemPrompt` in the request. Consumers (Dwell, the HA voice
// integration, etc.) are expected to manage their own prompts via Dwell's
// prompts API and pass them per-request — this default is just a sensible
// fallback for ad-hoc /api/command callers (e.g. curl during testing).
const DEFAULT_SYSTEM_PROMPT = `You are an expert Home Assistant automation assistant. You have MCP tools to fully manage a Home Assistant instance.

YOUR CAPABILITIES:
1. Discover devices and entities (list_entities with pagination, get_entity_state)
2. Create automations from natural language - translate what users describe into HA YAML automations
3. Manage automations (list, get details, create, update, delete, enable, disable)
4. Create and manage reusable scripts for complex action sequences
5. Schedule recurring tasks for any device (thermostats, vacuums, lights, etc.)
6. Control devices directly (lights, switches, climate, vacuums, scenes, media players, locks, fans, covers)
7. Generate Lovelace dashboard YAML configurations

DEVICE CAPABILITIES:
- NEVER assume capabilities from entity names - names are user-defined labels
- ALWAYS check 'attributes' from list_entities or get_entity_state

EFFICIENT WORKFLOW:
- list_entities supports pagination (page, page_size), domain filter, and search
- list_automations returns summaries only - use get_automation_by_id for full config
- call_service is the generic tool for ANY HA service
- When possible, combine actions into a single tool call

VERIFICATION: After any tool call that modifies HA, check the 'success' field and report the exact result.

Be concise. Respond with the action taken and result. No lengthy explanations.`;

// Env-overridable so the bridge isn't married to one consumer's layout.
// HomeAssistantAutomationService sets these in its launch script; a future
// non-HA consumer of BRIDGE_MODE=home-assistant would set them to point at
// its own checkout.
const HA_CWD =
  process.env.HA_PROJECT_CWD ??
  "F:/Code/Scratch/AI/AI Generated UIs/HomeAssistantAutomationService/HomeAssistantAutomationService";
const HA_MCP_COMMAND =
  process.env.HA_MCP_COMMAND ??
  "F:/Code/Scratch/AI/AI Generated UIs/HomeAssistantAutomationService/HomeAssistantAutomationService/src/HomeAssistantMcp/bin/Release/net8.0/HomeAssistantMcp.exe";

// SDK options template. systemPrompt is filled in per call so the caller
// can pass their own. Falls back to DEFAULT_SYSTEM_PROMPT.
const BASE_SDK_OPTIONS = {
  model: "claude-sonnet-4-6",
  maxTurns: 10,
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  cwd: HA_CWD,
  mcpServers: {
    "home-assistant": {
      command: HA_MCP_COMMAND,
      args: [] as string[],
    },
  },
};

// ---------- types ----------

export interface StreamCallbacks {
  onText: (content: string) => void;
  onTool: (toolName: string, status: "running" | "complete") => void;
  onDone: (result: {
    toolsUsed: string[];
    sessionId: string;
    durationMs: number;
    timing?: TimingReport;
  }) => void;
  onError: (error: string) => void;
}

interface ToolTiming {
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
}

export interface TimingReport {
  totalMs: number;
  sdkInitMs: number;
  apiThinkingMs: number;
  toolCalls: ToolTiming[];
  firstTextMs: number;
  phases: { label: string; ms: number }[];
}

// ---------- session state ----------

let sdkSessionId: string | null = null;

/**
 * Pre-warm the SDK session by running a no-op query.
 * This pays the MCP server startup cost once at bridge launch,
 * so the first real user query benefits from `resume`.
 */
export async function warmUp(): Promise<void> {
  console.log("[warmup] Starting pre-warm query...");
  const t0 = performance.now();

  const result = query({
    prompt: "Respond with just the word 'ready'. Do not use any tools.",
    options: { ...BASE_SDK_OPTIONS, systemPrompt: DEFAULT_SYSTEM_PROMPT, maxTurns: 1 },
  });

  for await (const event of result) {
    if (event.type === "system") {
      const sys = event as Record<string, unknown>;
      sdkSessionId = (sys.session_id as string) ?? sdkSessionId;
    }
  }

  console.log(`[warmup] Done in ${Math.round(performance.now() - t0)}ms (session: ${sdkSessionId?.slice(0, 8)}...)`);
}

// ---------- main API ----------

export interface ExecuteCommandOptions {
  /** Optional override for the SDK system prompt. Falls back to DEFAULT_SYSTEM_PROMPT. */
  systemPrompt?: string;
}

export async function executeCommand(
  message: string,
  callbacks: StreamCallbacks,
  abortSignal?: AbortSignal,
  opts: ExecuteCommandOptions = {},
): Promise<void> {
  const abortController = new AbortController();
  const toolsUsed: string[] = [];
  const systemPrompt =
    typeof opts.systemPrompt === "string" && opts.systemPrompt.trim().length > 0
      ? opts.systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

  // Timing state
  const t0 = performance.now();
  let tFirstEvent = 0;
  let tFirstText = 0;
  let tLastEvent = t0;
  let apiThinkingMs = 0;
  const toolTimings: ToolTiming[] = [];
  let currentTool: ToolTiming | null = null;
  const phases: { label: string; ms: number }[] = [];

  const elapsed = () => Math.round(performance.now() - t0);

  try {
    console.log(`[timing] ---- Query start: "${message.slice(0, 60)}" ----`);

    const options = { ...BASE_SDK_OPTIONS, systemPrompt, abortController };

    // Resume prior session if available
    if (sdkSessionId) {
      (options as Record<string, unknown>).resume = sdkSessionId;
    }

    let result: ReturnType<typeof query>;
    try {
      result = query({ prompt: message, options });
    } catch (queryErr) {
      console.error(`[claude-client] query() THREW:`, queryErr);
      callbacks.onError(`SDK query() failed: ${queryErr}`);
      return;
    }

    const tQueryCalled = performance.now();
    console.log(`[timing] +${elapsed()}ms  query() called`);

    let eventCount = 0;

    for await (const event of result) {
      const now = performance.now();
      const gap = Math.round(now - tLastEvent);
      eventCount++;

      if (eventCount === 1) {
        tFirstEvent = now;
        const initMs = Math.round(now - tQueryCalled);
        phases.push({ label: "sdk_init", ms: initMs });
        console.log(`[timing] +${elapsed()}ms  first event (sdk_init: ${initMs}ms)`);
      }

      if (eventCount === 1 && abortSignal && !abortSignal.aborted) {
        abortSignal.addEventListener("abort", () => abortController.abort());
      }

      const eventAny = event as Record<string, unknown>;

      switch (event.type) {
        case "system": {
          sdkSessionId = (eventAny.session_id as string) ?? sdkSessionId;
          console.log(`[timing] +${elapsed()}ms  system event (session: ${sdkSessionId?.slice(0, 8)}...)`);
          break;
        }

        case "assistant": {
          if (gap > 50) {
            apiThinkingMs += gap;
            phases.push({ label: "api_thinking", ms: gap });
            console.log(`[timing] +${elapsed()}ms  assistant event (api: ${gap}ms)`);
          }

          const msg = eventAny.message as {
            content?: Array<{
              type: string;
              text?: string;
              name?: string;
              id?: string;
            }>;
          } | undefined;

          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                if (!tFirstText) {
                  tFirstText = now;
                  const ttft = Math.round(now - t0);
                  phases.push({ label: "time_to_first_text", ms: ttft });
                  console.log(`[timing] +${elapsed()}ms  FIRST TEXT (${ttft}ms from start)`);
                }
                callbacks.onText(block.text);
              } else if (block.type === "tool_use" && block.name) {
                if (currentTool && !currentTool.endMs) {
                  currentTool.endMs = now;
                  currentTool.durationMs = Math.round(now - currentTool.startMs);
                }
                currentTool = { name: block.name, startMs: now };
                toolTimings.push(currentTool);
                toolsUsed.push(block.name);
                callbacks.onTool(block.name, "running");
                console.log(`[timing] +${elapsed()}ms  tool_use: ${block.name}`);
              }
            }
          }
          break;
        }

        case "user": {
          if (currentTool && !currentTool.endMs) {
            const now2 = performance.now();
            currentTool.endMs = now2;
            currentTool.durationMs = Math.round(now2 - currentTool.startMs);
            console.log(`[timing] +${elapsed()}ms  tool_result: ${currentTool.name} (${currentTool.durationMs}ms)`);
            phases.push({ label: `tool:${currentTool.name}`, ms: currentTool.durationMs });
          }
          const lastTool = toolsUsed[toolsUsed.length - 1];
          if (lastTool) callbacks.onTool(lastTool, "complete");
          break;
        }

        case "result": {
          const totalMs = Math.round(performance.now() - t0);
          const durationMs = (eventAny.duration_ms as number) ?? totalMs;
          const subtype = eventAny.subtype as string;

          const timing: TimingReport = {
            totalMs,
            sdkInitMs: Math.round((tFirstEvent || performance.now()) - tQueryCalled),
            apiThinkingMs,
            toolCalls: toolTimings,
            firstTextMs: tFirstText ? Math.round(tFirstText - t0) : totalMs,
            phases,
          };

          console.log(`[timing] ---- Query complete: ${totalMs}ms ----`);
          console.log(`[timing]   SDK init:        ${timing.sdkInitMs}ms`);
          console.log(`[timing]   First text:      ${timing.firstTextMs}ms`);
          console.log(`[timing]   API thinking:    ${apiThinkingMs}ms`);
          for (const t of toolTimings) {
            console.log(`[timing]   Tool ${t.name}: ${t.durationMs ?? "?"}ms`);
          }
          console.log(`[timing]   Total:           ${totalMs}ms`);

          if (subtype?.startsWith("error")) {
            callbacks.onError((eventAny.result as string) || `Query ended with: ${subtype}`);
          } else {
            callbacks.onDone({
              toolsUsed: [...new Set(toolsUsed)],
              sessionId: sdkSessionId ?? "unknown",
              durationMs,
              timing,
            });
          }
          return;
        }

        default:
          break;
      }

      tLastEvent = now;
    }

    const totalMs = Math.round(performance.now() - t0);
    callbacks.onDone({
      toolsUsed: [...new Set(toolsUsed)],
      sessionId: sdkSessionId ?? "unknown",
      durationMs: totalMs,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    if (abortSignal?.aborted || errMsg.includes("aborted")) {
      console.log(`[claude-client] Query aborted (client disconnect)`);
      callbacks.onDone({
        toolsUsed: [...new Set(toolsUsed)],
        sessionId: sdkSessionId ?? "unknown",
        durationMs: 0,
      });
    } else {
      console.error(`[claude-client] Error: ${errMsg}`);
      callbacks.onError(errMsg);
    }
  }
}
