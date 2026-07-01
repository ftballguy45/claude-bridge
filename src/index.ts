import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import { executeCommand, warmUp } from "./claude-client.js";
import { runLocalModel, checkOllamaHealth } from "./local-model.js";
import { startMcpServer, stopMcpServer } from "./mcp-client.js";
import type { CommandRequest } from "./types.js";
import { runClassify, type ClassifyRequest } from "./classify.js";
import { getUsage } from "./usage.js";
import { USAGE_UI_HTML } from "./usage-ui.js";
import { createWriteStream } from "fs";
import { resolve } from "path";

// Log file path resolution:
//   1. LOG_FILE env var (preferred; set explicitly by Docker / launchers).
//   2. Legacy fallback — three levels up from src/, into src/bridge.log.
//      Preserved so existing non-Docker runs keep behaving the same way.
//   3. If neither works (e.g. read-only layout), skip file logging and
//      just write to stdout. The container-side log capture picks it up.
const LOG_FILE = (() => {
  if (process.env.LOG_FILE) return process.env.LOG_FILE;
  try {
    const projectRoot = decodeURIComponent(
      resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"))
    );
    return resolve(projectRoot, "src", "bridge.log");
  } catch {
    return null;
  }
})();

const logStream = LOG_FILE
  ? (() => {
      try {
        const s = createWriteStream(LOG_FILE, { flags: "a" });
        s.on("error", (err) => {
          // Swallow — if disk logging breaks, we still have stdout.
          // Wrapped via origError so we don't recurse through the overrides.
          // eslint-disable-next-line no-console
          console.error(`[bridge] log stream error (${LOG_FILE}): ${err.message}`);
        });
        return s;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[bridge] Unable to open log file ${LOG_FILE}; stdout-only logging. Error:`, err);
        return null;
      }
    })()
  : null;

const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const writeLog = (prefix: string, args: unknown[]) => {
  if (!logStream || !logStream.writable) return;
  try {
    logStream.write(`[${new Date().toISOString()}] ${prefix} ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`);
  } catch {
    // Swallow — stdout still has the message.
  }
};
console.log = (...args) => { writeLog("LOG", args); origLog(...args); };
console.error = (...args) => { writeLog("ERR", args); origError(...args); };
console.warn = (...args) => { writeLog("WRN", args); origWarn(...args); };

// Prevent EPIPE from crashing the process
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") {
    console.warn(`[bridge] Ignoring ${err.code}: ${err.message}`);
    return;
  }
  console.error("[bridge] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason as NodeJS.ErrnoException | undefined;
  if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
    console.warn(`[bridge] Ignoring unhandled rejection ${err.code}: ${err.message}`);
    return;
  }
  console.error("[bridge] Unhandled rejection:", reason);
});

const PORT = parseInt(process.env.PORT ?? "3100", 10);

const app = express();
app.use(express.json());

// --- SSE helper ---
function sendSSE(res: Response, event: string, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    const socket = res.socket;
    if (socket && !socket.destroyed) socket.cork();
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (socket && !socket.destroyed) process.nextTick(() => socket.uncork());
    return true;
  } catch {
    return false;
  }
}

function safeEnd(res: Response): void {
  if (!res.writableEnded && !res.destroyed) {
    try { res.end(); } catch { /* already closed */ }
  }
}

// --- Routing: detect simple device commands vs complex queries ---
let ollamaAvailable = false;

// Simple device control patterns — these go to the local model
const SIMPLE_PATTERNS = [
  /\b(turn|switch|set|change|make|dim|brighten)\b.*(light|lamp|led|switch|fan|plug|outlet)/i,
  /\b(turn|switch)\b.*(on|off)\b/i,
  /\b(lock|unlock)\b/i,
  /\b(open|close)\b.*(cover|blind|shade|garage|door)/i,
  /\b(start|stop|pause|dock)\b.*(vacuum|roomba|roborock)/i,
  /\bset\b.*\b(temp|temperature|thermostat|climate)\b/i,
  /\b(activate|trigger)\b.*\bscene\b/i,
  /\b(color|colour|rgb|blue|red|green|purple|pink|orange|yellow|white|warm|cool)\b.*\b(light|led|lamp|strip)\b/i,
  /\b(light|led|lamp|strip)\b.*\b(color|colour|rgb|blue|red|green|purple|pink|orange|yellow|white|warm|cool)\b/i,
  /\b(brightness|bright|dim)\b/i,
];

function isSimpleCommand(msg: string): boolean {
  return SIMPLE_PATTERNS.some((p) => p.test(msg));
}

// --- Model tiering ---
// Simple device control runs on the fastest model; anything more involved
// (automations, multi-step, open-ended queries) gets the stronger model. A
// caller-supplied model (Dwell prompt model / integration override) always
// wins over this — see the /api/command handler.
const SIMPLE_MODEL = "claude-haiku-4-5";
const COMPLEX_MODEL = "claude-sonnet-4-6";
function chooseModel(msg: string): string {
  return isSimpleCommand(msg) ? SIMPLE_MODEL : COMPLEX_MODEL;
}

// --- Activity reporting ---
// Fire-and-forget a per-turn record to Dwell (DWELL_ACTIVITY_URL) so it can be
// viewed in the dashboard instead of tailing logs. Reporting must NEVER affect
// the turn — errors are swallowed.
const DWELL_ACTIVITY_URL = process.env.DWELL_ACTIVITY_URL;
interface ActivityRecord {
  command: string;
  route: "claude" | "local";
  model?: string;
  modelAutoTiered?: boolean;
  durationMs?: number;
  firstTextMs?: number;
  tools?: string[];
  toolCount?: number;
  status: "ok" | "error" | "timeout" | "aborted";
  /** Conversation id (HA conversation_id) so Dwell can thread turns. */
  conversationId?: string;
  /** The assistant's reply text for this turn (Dwell truncates). */
  response?: string;
}
function reportActivity(record: ActivityRecord): void {
  if (!DWELL_ACTIVITY_URL) return;
  fetch(`${DWELL_ACTIVITY_URL.replace(/\/$/, "")}/api/ai/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  }).catch((err) =>
    console.warn(
      "[bridge] activity report failed:",
      err instanceof Error ? err.message : err,
    ),
  );
}

// --- POST /api/command ---
app.post("/api/command", (req: Request, res: Response) => {
  const { message, systemPrompt, model, conversationId } = req.body as CommandRequest;

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (systemPrompt) {
    console.log(`[bridge] Using caller-supplied systemPrompt (${systemPrompt.length} chars)`);
  }
  if (model) {
    console.log(`[bridge] Using caller-supplied model: ${model}`);
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.socket?.on("error", () => {});

  sendSSE(res, "session", { sessionId: "persistent" });

  let commandFinished = false;
  // Accumulates the assistant's reply text so we can log it to Dwell's AI Activity.
  let responseText = "";
  // Abort the in-flight SDK query if the caller (HA) hangs up, so we don't keep
  // burning tokens/turns on a request nobody is listening to anymore.
  const abortController = new AbortController();
  req.on("close", () => {
    if (!commandFinished) {
      console.log("[bridge] Client disconnected — aborting in-flight query");
      abortController.abort();
    }
  });

  const useLocal = ollamaAvailable && isSimpleCommand(message);
  console.log(`[bridge] Route: ${useLocal ? "LOCAL" : "CLAUDE"} for "${message.slice(0, 60)}"`);

  (async () => {
    try {
      if (useLocal) {
        // Fast path: local model
        const result = await runLocalModel(message);
        commandFinished = true;

        for (const tool of result.toolsUsed) {
          sendSSE(res, "tool", { tool, status: "running" });
          sendSSE(res, "tool", { tool, status: "complete" });
        }
        sendSSE(res, "text", { content: result.text });
        sendSSE(res, "done", {
          toolsUsed: result.toolsUsed,
          sessionId: "local",
          durationMs: result.durationMs,
        });
        safeEnd(res);
        reportActivity({
          command: message,
          route: "local",
          model: "ollama (local)",
          durationMs: result.durationMs,
          tools: result.toolsUsed,
          toolCount: result.toolsUsed.length,
          status: "ok",
          conversationId,
          response: result.text,
        });
      } else {
        // Smart path: Claude SDK. Model precedence: caller-supplied (Dwell
        // prompt model / integration override) wins; otherwise auto-tier by
        // command complexity (Haiku for simple control, Sonnet otherwise).
        const effectiveModel =
          model && model.trim() ? model.trim() : chooseModel(message);
        console.log(
          `[bridge] Model: ${effectiveModel}` +
            (model && model.trim() ? " (caller-supplied)" : " (auto-tiered)"),
        );
        await executeCommand(message, {
          onText: (content) => { responseText += content; sendSSE(res, "text", { content }); },
          onTool: (tool, status) => sendSSE(res, "tool", { tool, status }),
          onDone: (result) => {
            commandFinished = true;
            sendSSE(res, "done", result);
            safeEnd(res);
            reportActivity({
              command: message,
              route: "claude",
              model: effectiveModel,
              modelAutoTiered: !(model && model.trim()),
              durationMs: result.durationMs,
              firstTextMs: result.timing?.firstTextMs,
              tools: result.toolsUsed,
              toolCount: result.toolsUsed?.length ?? 0,
              status: "ok",
              conversationId,
              response: responseText,
            });
          },
          onError: (error) => {
            commandFinished = true;
            sendSSE(res, "error", { error });
            safeEnd(res);
            reportActivity({
              command: message,
              route: "claude",
              model: effectiveModel,
              modelAutoTiered: !(model && model.trim()),
              status: "error",
              tools: [],
              toolCount: 0,
              conversationId,
              response: responseText,
            });
          },
        }, abortController.signal, { systemPrompt, model: effectiveModel });
      }
    } catch (err) {
      console.error("[bridge] Command failed:", err);
      commandFinished = true;
      sendSSE(res, "error", { error: String(err) });
      safeEnd(res);
    }
  })();
});

// --- GET /api/health ---
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
  });
});

// Alias for Docker healthchecks / generic "is it up" pings.
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// --- POST /classify ---
// Generic completion endpoint — simple JSON in / JSON out. Used by any
// consumer that treats the bridge as an `IChatClient` (the WorkflowBuilder's
// ClaudeBridgeChatClient posts here). Does NOT stream and does NOT use the
// HA-specific MCP tools / system prompt that /api/command uses.
app.post("/classify", async (req: Request, res: Response) => {
  try {
    const body = req.body as ClassifyRequest;
    const result = await runClassify(body);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bridge] /classify error:", msg);
    res.status(500).json({ error: msg });
  }
});

// --- GET /usage ---
// Subscription rate-limit utilization (5h + 7d windows) for the OAuth token this
// bridge runs on. Harvested from anthropic-ratelimit-unified-* response headers via
// a tiny cached probe — see usage.ts. Account-wide, not per-container.
app.get("/usage", async (_req: Request, res: Response) => {
  try {
    // Permissive CORS so a dashboard on another origin (Dwell, a tablet page)
    // can read it. Usage percentages aren't sensitive.
    res.set("Access-Control-Allow-Origin", "*");
    res.json(await getUsage());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bridge] /usage error:", msg);
    res.status(500).json({ error: msg });
  }
});

// --- GET /usage/ui ---
// Tiny self-contained live dashboard (auto-refreshing bars + reset countdowns).
// Same-origin fetch of /usage, no external assets. Open in a browser.
app.get("/usage/ui", (_req: Request, res: Response) => {
  res.type("html").send(USAGE_UI_HTML);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Claude Bridge listening on http://localhost:${PORT}`);
  console.log(`  POST /classify        — generic completion (JSON in/out)`);
  console.log(`  POST /api/command     — HA command (SSE stream, MCP-enabled)`);
  console.log(`  GET  /usage           — subscription rate-limit utilization (5h/7d)`);
  console.log(`  GET  /usage/ui        — live usage dashboard (HTML)`);
  console.log(`  GET  /health          — health check`);
  console.log(`  GET  /api/health      — health check (legacy alias)`);

  // Self-diagnose activity reporting so it's obvious at boot whether the
  // DWELL_ACTIVITY_URL env var reached this container (a common deploy miss).
  if (DWELL_ACTIVITY_URL) {
    console.log(`  activity reporting    -> ${DWELL_ACTIVITY_URL.replace(/\/$/, "")}/api/ai/activity`);
  } else {
    console.log(`  activity reporting    -> disabled (DWELL_ACTIVITY_URL unset)`);
  }

  // HA-specific init (MCP server spawn + warmup). Skipped when BRIDGE_MODE
  // is "generic" — useful for consumers like WorkflowBuilder that only use
  // /classify and have no Home Assistant backend to talk to.
  const mode = (process.env.BRIDGE_MODE ?? "home-assistant").toLowerCase();
  if (mode === "generic") {
    console.log("[bridge] BRIDGE_MODE=generic — skipping MCP + HA warmup");
  } else {
    const mcpReady = startMcpServer().catch((err) => {
      console.error("[bridge] MCP server failed to start:", err);
    });

    const ollamaCheck = checkOllamaHealth().then((available) => {
      ollamaAvailable = available;
      console.log(`[bridge] Ollama: ${available ? "AVAILABLE" : "not available — all commands go to Claude"}`);
    });

    Promise.all([mcpReady, ollamaCheck]).then(() => {
      console.log("[bridge] Ready to accept commands!");
    });

    warmUp().catch((err) => {
      console.error("[bridge] Claude warm-up failed (first query will be slower):", err);
    });
  }
});

// Cleanup on exit
process.on("SIGTERM", () => { stopMcpServer(); process.exit(0); });
process.on("SIGINT", () => { stopMcpServer(); process.exit(0); });
