import { query } from "@anthropic-ai/claude-agent-sdk";

// Baked-in default system prompt. Used when a consumer does NOT pass an
// explicit `systemPrompt` in the request. Consumers (Dwell, the HA voice
// integration, etc.) are expected to manage their own prompts via Dwell's
// prompts API and pass them per-request — this default is just a sensible
// fallback for ad-hoc /api/command callers (e.g. curl during testing).
// Minimal fallback only. Real consumers (Dwell, the HA voice integration) pass
// their own systemPrompt per request — that's the single source of truth for
// behaviour. Capability/usage guidance is single-sourced in the MCP server's
// instructions + tool descriptions (served by the .NET API), so it's NOT
// duplicated here. Used for ad-hoc /api/command callers (e.g. curl) only.
const DEFAULT_SYSTEM_PROMPT = `You are a Home Assistant assistant with MCP tools to discover, control, and automate a Home Assistant instance. After any change, check the tool's 'success' field and report the result. Be concise.`;

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

// Preferred transport: connect to the long-running HTTP MCP server (the .NET API
// hosts it at /mcp, e.g. http://ha-automation-service:8080/mcp). This decouples
// the bridge from the MCP build — no stdio child to spawn, no file locks, no
// bind-mounted binary. Falls back to spawning the stdio MCP binary when unset.
const HA_MCP_URL = process.env.HA_MCP_URL;

const HA_MCP_SERVER = HA_MCP_URL
  ? { type: "http" as const, url: HA_MCP_URL }
  : { command: HA_MCP_COMMAND, args: [] as string[] };

// SDK options template. systemPrompt is filled in per call so the caller
// can pass their own. Falls back to DEFAULT_SYSTEM_PROMPT.
// Claude Code's built-in agent tools. This is a Home Assistant VOICE bridge,
// not a coding agent — the model must use ONLY the Home Assistant MCP tools.
// If these built-ins are left enabled, a weaker model (Haiku, used for simple
// voice commands) grabs Bash/Glob/Grep and "searches the container filesystem"
// instead of calling list_entities/call_service — and it's a security hole
// (arbitrary shell in the container, driven by a voice prompt). Block them all.
const BUILTIN_TOOLS_TO_BLOCK = [
  "Bash", "BashOutput", "KillShell",
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep",
  "Task", "Agent",
  "WebFetch", "WebSearch", "TodoWrite",
];

const BASE_SDK_OPTIONS = {
  model: "claude-sonnet-4-6",
  maxTurns: 10,
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  // Restrict to the Home Assistant MCP tools only — no shell/filesystem tools.
  disallowedTools: BUILTIN_TOOLS_TO_BLOCK,
  // cwd only matters when spawning the stdio child; HTTP needs no working dir.
  cwd: HA_MCP_URL ? process.cwd() : HA_CWD,
  mcpServers: {
    "home-assistant": HA_MCP_SERVER,
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
  /** Optional override for the Claude model. Falls back to BASE_SDK_OPTIONS.model. */
  model?: string;
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
  const model =
    typeof opts.model === "string" && opts.model.trim().length > 0
      ? opts.model.trim()
      : BASE_SDK_OPTIONS.model;

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

    const options = { ...BASE_SDK_OPTIONS, systemPrompt, model, abortController };

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
