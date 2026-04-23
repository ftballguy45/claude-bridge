# syntax=docker/dockerfile:1.6
#
# Claude Bridge — stateless HTTP sidecar that wraps the Claude Agent SDK.
# Multi-stage build: compile TS → slim runtime image.
# Consumer projects run this image on a port of their choosing.
#
# Build:   docker build -t claude-bridge:latest .
# Run:     docker run --rm -p 3100:3100 --env-file .env claude-bridge:latest

# ─── Stage 1: build ───────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Copy manifest first for a better Docker layer cache hit when only src changes.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Install production deps into a clean dir to ship in the runtime image.
RUN mkdir -p /app/prod && cp package.json package-lock.json* /app/prod/ \
 && cd /app/prod && npm ci --omit=dev --no-audit --no-fund

# ─── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root by default.
RUN addgroup -S bridge && adduser -S bridge -G bridge
USER bridge

COPY --from=build --chown=bridge:bridge /app/prod/node_modules ./node_modules
COPY --from=build --chown=bridge:bridge /app/dist ./dist
COPY --from=build --chown=bridge:bridge /app/package.json ./package.json

# Inside-container port. Consumers remap this on the host via -p <host>:3100.
ENV PORT=3100
# Write the bridge's file log somewhere writable. Stdout is the primary
# sink anyway — this is just a supplemental debug trail.
ENV LOG_FILE=/tmp/bridge.log
# "generic" skips the Home-Assistant MCP + warmup on startup. Consumers
# that DO want the HA integration override this to "home-assistant" via
# compose env, and mount the MCP binary in.
ENV BRIDGE_MODE=generic
ENV NODE_ENV=production

EXPOSE 3100

# The SDK spawns `claude` (Claude Agent CLI) from PATH. The OAuth token is
# supplied via CLAUDE_CODE_OAUTH_TOKEN env var, passed through by the caller.
CMD ["node", "dist/index.js"]
