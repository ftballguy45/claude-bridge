# claude-bridge

A tiny stateless Node.js HTTP sidecar that wraps the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
Consumer apps (ASP.NET Core, Python, another Node service, whatever) make
regular HTTP calls against this bridge instead of embedding the Node SDK
directly.

Designed to be **shared across multiple consumer projects** — one image,
each project runs its own container on its own port.

## Endpoints

| Method | Path             | Purpose |
|--------|------------------|---------|
| `POST` | `/classify`      | Generic completion. JSON in → JSON out. Non-streaming. The canonical endpoint for any `IChatClient`-style consumer. |
| `POST` | `/api/command`   | Home Assistant agent command. SSE stream with tool-use events. Only useful when `BRIDGE_MODE=home-assistant`. |
| `GET`  | `/health`        | Liveness probe. `{ status, uptime }`. |
| `GET`  | `/api/health`    | Legacy alias of `/health`. |

### `/classify` request/response

```json
POST /classify
{
  "systemPrompt": "You are a terse assistant.",
  "userMessage": "Summarize this paragraph in one sentence: ...",
  "model": "claude-haiku-4-5",          // optional
  "jsonSchema": { "type": "object", ... } // optional — structured output
}

→
{ "text": "...", "durationMs": 2785 }
```

When `jsonSchema` is provided, the bridge prepends a strict-JSON instruction
to the system prompt and inlines the schema. Validation against that schema
is **not** done here — that's the consumer's job.

## Running with Docker (recommended)

```bash
docker build -t claude-bridge:latest .
docker run -d --rm \
  -p 3100:3100 \
  --env-file .env \
  claude-bridge:latest
curl http://localhost:3100/health
```

### Multi-project setup

Each consumer project has its own `docker-compose.yml` pointing at this
repo (as a context) with a **different host port**:

```yaml
# Project A
services:
  claude-bridge:
    build:
      context: ../claude-bridge
    ports: ["3100:3100"]
    env_file: ./.env.bridge

# Project B (runs concurrently, different port)
services:
  claude-bridge:
    build:
      context: ../claude-bridge
    ports: ["3101:3100"]
    env_file: ./.env.bridge
```

Both point at the same bridge source tree; Docker builds one image per
consumer and the containers stay isolated by host port.

## Running without Docker

```bash
npm install
npm run build
CLAUDE_CODE_OAUTH_TOKEN=<token> PORT=3100 node dist/index.js
```

## Configuration

All via env vars:

| Var | Purpose | Default |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Required. Claude Code CLI OAuth token — bills against your Claude subscription. `claude --print-oauth-token` to fetch one. | — |
| `PORT` | Listen port. | `3100` |
| `BRIDGE_MODE` | `generic` skips HA-specific MCP spawn + warmup on startup (use for any non-HA consumer). `home-assistant` enables it. | `home-assistant` on bare node, `generic` in Docker |
| `LOG_FILE` | Optional supplemental debug log. Container default `/tmp/bridge.log`. Unset in bare node → legacy `src/bridge.log`. | — |
| `SESSION_TTL_MS` | Claude SDK session TTL. | `1800000` (30 min) |

## Home Assistant consumer (legacy)

The bridge was originally built for
[`HomeAssistantAutomationService`](https://github.com/ftballguy45/HomeAssistantAutomationService).
When `BRIDGE_MODE=home-assistant`, the startup flow:
1. Spawns the HA MCP server as a stdio child process
2. Pre-warms a Claude SDK session with an HA-tuned system prompt

For that use case, you also need the HA MCP server binary reachable
inside the container (bind-mount or separate service).

## Layout

```
src/
├── index.ts          # HTTP server, endpoint routing
├── classify.ts       # /classify handler (generic completion)
├── claude-client.ts  # /api/command handler (HA streaming)
├── local-model.ts    # Ollama fallback for simple commands
├── mcp-client.ts     # HA MCP server stdio client
└── types.ts
Dockerfile            # multi-stage build
.dockerignore
tsconfig.json
```

## License

Private — personal dev. No warranty.
