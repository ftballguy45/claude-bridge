/**
 * MCP stdio client — spawns the HA MCP server as a persistent child process
 * and communicates via JSON-RPC over stdin/stdout.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface } from "readline";

// Override with HA_MCP_COMMAND env var when running against a different
// checkout; fallback is the default HomeAssistantAutomationService layout.
const MCP_EXE =
  process.env.HA_MCP_COMMAND ??
  "F:/Code/Scratch/AI/AI Generated UIs/HomeAssistantAutomationService/HomeAssistantAutomationService/src/HomeAssistantMcp/bin/Release/net8.0/HomeAssistantMcp.exe";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

let mcpProcess: ChildProcess | null = null;
let readline: Interface | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();
let toolSchemas: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

/**
 * Start the MCP server process and perform the initialize handshake.
 */
export async function startMcpServer(): Promise<void> {
  if (mcpProcess) return;

  console.log("[mcp] Starting HA MCP server...");
  const t0 = performance.now();

  mcpProcess = spawn(MCP_EXE, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Log stderr (server logs) to console
  mcpProcess.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      console.log(`[mcp:stderr] ${line}`);
    }
  });

  mcpProcess.on("exit", (code) => {
    console.log(`[mcp] Server exited with code ${code}`);
    mcpProcess = null;
    readline = null;
    // Reject all pending requests
    for (const [id, req] of pending) {
      req.reject(new Error(`MCP server exited (code ${code})`));
      pending.delete(id);
    }
  });

  // Read JSON-RPC responses line by line from stdout
  readline = createInterface({ input: mcpProcess.stdout! });
  readline.on("line", (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        if (msg.error) {
          req.reject(new Error(`MCP error: ${msg.error.message}`));
        } else {
          req.resolve(msg.result);
        }
      }
    } catch {
      // Ignore non-JSON lines (e.g. notifications)
    }
  });

  // Initialize handshake
  const initResult = await rpcCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "claude-bridge", version: "1.0.0" },
  }) as { serverInfo: { name: string }; capabilities: Record<string, unknown> };

  console.log(`[mcp] Server initialized: ${initResult.serverInfo?.name}`);

  // Send initialized notification
  sendNotification("notifications/initialized", {});

  // Discover tools
  const toolsResult = await rpcCall("tools/list", {}) as {
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  };
  toolSchemas = toolsResult.tools ?? [];
  console.log(`[mcp] Discovered ${toolSchemas.length} tools in ${Math.round(performance.now() - t0)}ms`);
}

/**
 * Call a tool on the MCP server.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  if (!mcpProcess) {
    await startMcpServer();
  }

  const result = await rpcCall("tools/call", { name, arguments: args }) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };

  const text = result.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? JSON.stringify(result);

  return { content: text, isError: result.isError ?? false };
}

/**
 * Get tool schemas in OpenAI function-calling format for the local model.
 */
export function getToolsForModel(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return toolSchemas.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Shut down the MCP server.
 */
export function stopMcpServer(): void {
  if (mcpProcess) {
    console.log("[mcp] Stopping server...");
    mcpProcess.kill();
    mcpProcess = null;
    readline = null;
  }
}

// --- internal helpers ---

function rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!mcpProcess?.stdin?.writable) {
      reject(new Error("MCP server not running"));
      return;
    }

    const id = nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    pending.set(id, { resolve, reject });

    const line = JSON.stringify(request) + "\n";
    mcpProcess.stdin.write(line);

    // Timeout after 30s
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP call '${method}' timed out after 30s`));
      }
    }, 30000);
  });
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  if (!mcpProcess?.stdin?.writable) return;
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  mcpProcess.stdin.write(msg);
}
