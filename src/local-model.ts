/**
 * Local model client using Ollama + MCP server for HA control.
 * Tool schemas are discovered dynamically from the MCP server.
 * Tool calls are executed via the MCP stdio client.
 */

import { callTool, getToolsForModel } from "./mcp-client.js";

const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma3:4b";

const SYSTEM_PROMPT = `You are a Home Assistant voice controller. Given a user command, call the appropriate tool to control their smart home devices.

Rules:
- For colors, use rgb_color as [r,g,b] array in service_data_json (e.g. deep blue = [0,0,139])
- For brightness, use brightness 0-255 in service_data_json
- Entity IDs use the pattern: domain.name (e.g. light.office_leds, switch.kitchen)
- call_service is the most versatile tool — use it for lights, switches, fans, covers, locks, media players
- service_data_json must be a valid JSON string, not an object
- Be concise — just confirm what you did`;

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolCallResult {
  tool: string;
  success: boolean;
  message: string;
}

export interface LocalModelResult {
  text: string;
  toolsUsed: string[];
  durationMs: number;
  toolResults: ToolCallResult[];
}

/**
 * Check if Ollama is running and the model is available.
 * Also pre-loads the model into VRAM so the first real query is fast.
 */
export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!resp.ok) return false;
    const data = (await resp.json()) as { models: Array<{ name: string }> };
    const modelShort = OLLAMA_MODEL.split(":")[0];
    const available = data.models?.some((m) => m.name.includes(modelShort)) ?? false;

    if (available) {
      // Pre-load model into VRAM
      console.log("[local] Pre-loading model into VRAM...");
      const t0 = performance.now();
      await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          keep_alive: -1,
        }),
      });
      console.log(`[local] Model loaded in ${Math.round(performance.now() - t0)}ms`);
    }

    return available;
  } catch {
    return false;
  }
}

/**
 * Run a command through the local model with MCP tool calling.
 */
export async function runLocalModel(userMessage: string): Promise<LocalModelResult> {
  const t0 = performance.now();
  const toolsUsed: string[] = [];
  const toolResults: ToolCallResult[] = [];

  // Get all tool schemas dynamically from the MCP server
  const tools = getToolsForModel();

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  // Step 1: Ask the model what to do
  console.log(`[local] Calling Ollama (${OLLAMA_MODEL}) with ${tools.length} tools...`);
  const t1 = performance.now();

  const chatResp = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      tools,
      stream: false,
      keep_alive: -1, // keep model loaded in VRAM indefinitely
    }),
  });

  if (!chatResp.ok) {
    const errText = await chatResp.text();
    throw new Error(`Ollama error: ${chatResp.status} ${errText}`);
  }

  const chatData = (await chatResp.json()) as {
    message: OllamaMessage;
    done: boolean;
  };

  const inferenceMs = Math.round(performance.now() - t1);
  console.log(`[local] Inference: ${inferenceMs}ms`);

  const assistantMsg = chatData.message;

  // Step 2: Execute any tool calls via MCP server
  if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
    messages.push(assistantMsg);

    for (const toolCall of assistantMsg.tool_calls) {
      const fnName = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      toolsUsed.push(fnName);
      console.log(`[local] MCP tool call: ${fnName}(${JSON.stringify(args)})`);

      const t2 = performance.now();
      try {
        const mcpResult = await callTool(fnName, args);
        const toolMs = Math.round(performance.now() - t2);
        console.log(`[local] MCP result (${toolMs}ms): ${mcpResult.content.slice(0, 200)}`);

        toolResults.push({
          tool: fnName,
          success: !mcpResult.isError,
          message: mcpResult.content,
        });

        messages.push({
          role: "tool",
          content: mcpResult.content,
          tool_call_id: toolCall.id,
        });
      } catch (err) {
        const toolMs = Math.round(performance.now() - t2);
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[local] MCP error (${toolMs}ms): ${errMsg}`);

        toolResults.push({ tool: fnName, success: false, message: errMsg });
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: errMsg }),
          tool_call_id: toolCall.id,
        });
      }
    }

    // Step 3: Ask the model to summarize the tool results for the user
    const t3 = performance.now();
    const finalResp = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        keep_alive: -1,
      }),
    });

    const finalData = (await finalResp.json()) as { message: OllamaMessage };
    const finalMs = Math.round(performance.now() - t3);

    const totalMs = Math.round(performance.now() - t0);
    console.log(`[local] Total: ${totalMs}ms (inference: ${inferenceMs}ms, final: ${finalMs}ms)`);

    return {
      text: finalData.message.content || "Done.",
      toolsUsed,
      durationMs: totalMs,
      toolResults,
    };
  }

  // No tool calls — just return the text response
  const totalMs = Math.round(performance.now() - t0);
  return {
    text: assistantMsg.content || "I'm not sure how to handle that command.",
    toolsUsed,
    durationMs: totalMs,
    toolResults,
  };
}
