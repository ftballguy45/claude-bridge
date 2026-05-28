import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import { executeCommand, warmUp } from "./claude-client.js";
import { runLocalModel, checkOllamaHealth } from "./local-model.js";
import { startMcpServer, stopMcpServer } from "./mcp-client.js";
import type { CommandRequest } from "./types.js";
import { runClassify, type ClassifyRequest } from "./classify.js";
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

// --- POST /api/command ---
app.post("/api/command", (req: Request, res: Response) => {
  const { message, systemPrompt } = req.body as CommandRequest;

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (systemPrompt) {
    console.log(`[bridge] Using caller-supplied systemPrompt (${systemPrompt.length} chars)`);
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
  req.on("close", () => {
    if (!commandFinished) {
      console.log("[bridge] Client disconnected");
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
      } else {
        // Smart path: Claude SDK
        const abortController = new AbortController();
        await executeCommand(message, {
          onText: (content) => sendSSE(res, "text", { content }),
          onTool: (tool, status) => sendSSE(res, "tool", { tool, status }),
          onDone: (result) => {
            commandFinished = true;
            sendSSE(res, "done", result);
            safeEnd(res);
          },
          onError: (error) => {
            commandFinished = true;
            sendSSE(res, "error", { error });
            safeEnd(res);
          },
        }, abortController.signal, { systemPrompt });
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

// --- Start ---
app.listen(PORT, () => {
  console.log(`Claude Bridge listening on http://localhost:${PORT}`);
  console.log(`  POST /classify        — generic completion (JSON in/out)`);
  console.log(`  POST /api/command     — HA command (SSE stream, MCP-enabled)`);
  console.log(`  GET  /health          — health check`);
  console.log(`  GET  /api/health      — health check (legacy alias)`);

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
