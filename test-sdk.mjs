import { query } from "@anthropic-ai/claude-agent-sdk";

console.log("Starting query...");

const result = query({
  prompt: "Say hello in one sentence.",
  options: {
    systemPrompt: "You are a helpful assistant. Respond briefly.",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
});

console.log("query() returned, type:", typeof result);

let count = 0;
for await (const event of result) {
  count++;
  console.log(`Event #${count}:`, JSON.stringify(event, null, 2).slice(0, 500));
}

console.log(`Done. Total events: ${count}`);
