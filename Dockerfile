# ── KirkForge: Deterministic delegation plugin ──────────────────────────────
# Multi-stage build for minimal production image.

# Stage 1: Build
# Note: better-sqlite3 requires native compilation. If you switch
# to FileAdapter-only, you can remove build-essential and use --ignore-scripts.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.package.json ./
COPY packages/core-types/package.json packages/core-types/tsconfig.json packages/core-types/
COPY packages/core-errors/package.json packages/core-errors/tsconfig.json packages/core-errors/
COPY packages/core-schemas/package.json packages/core-schemas/tsconfig.json packages/core-schemas/
COPY packages/core-events/package.json packages/core-events/tsconfig.json packages/core-events/
COPY packages/core-logging/package.json packages/core-logging/tsconfig.json packages/core-logging/
COPY packages/core-config/package.json packages/core-config/tsconfig.json packages/core-config/
COPY packages/core-secrets/package.json packages/core-secrets/tsconfig.json packages/core-secrets/
COPY packages/core-tenancy/package.json packages/core-tenancy/tsconfig.json packages/core-tenancy/

COPY packages/core-telemetry/package.json packages/core-telemetry/tsconfig.json packages/core-telemetry/
COPY packages/model-config/package.json packages/model-config/tsconfig.json packages/model-config/
COPY packages/model-client/package.json packages/model-client/tsconfig.json packages/model-client/
COPY packages/prompt-core/package.json packages/prompt-core/tsconfig.json packages/prompt-core/
COPY packages/agent-core/package.json packages/agent-core/tsconfig.json packages/agent-core/
COPY packages/correction-core/package.json packages/correction-core/tsconfig.json packages/correction-core/
COPY packages/memory-palace/package.json packages/memory-palace/tsconfig.json packages/memory-palace/
COPY packages/orchestrator/package.json packages/orchestrator/tsconfig.json packages/orchestrator/
COPY packages/plugin/package.json packages/plugin/tsconfig.json packages/plugin/
COPY packages/tool-lint-core/package.json packages/tool-lint-core/tsconfig.json packages/tool-lint-core/
COPY packages/tool-lint-ts/package.json packages/tool-lint-ts/tsconfig.json packages/tool-lint-ts/
COPY packages/tool-lint-py/package.json packages/tool-lint-py/tsconfig.json packages/tool-lint-py/
COPY packages/tool-lint-sh/package.json packages/tool-lint-sh/tsconfig.json packages/tool-lint-sh/
COPY packages/tool-lint-c/package.json packages/tool-lint-c/tsconfig.json packages/tool-lint-c/
COPY packages/tool-lint-rs/package.json packages/tool-lint-rs/tsconfig.json packages/tool-lint-rs/
COPY packages/tool-lint-go/package.json packages/tool-lint-go/tsconfig.json packages/tool-lint-go/
COPY packages/tool-lint-sql/package.json packages/tool-lint-sql/tsconfig.json packages/tool-lint-sql/
COPY packages/tool-tsc/package.json packages/tool-tsc/tsconfig.json packages/tool-tsc/
COPY packages/tool-pyright/package.json packages/tool-pyright/tsconfig.json packages/tool-pyright/
COPY packages/tool-gitnexus/package.json packages/tool-gitnexus/tsconfig.json packages/tool-gitnexus/
COPY packages/tool-graphify/package.json packages/tool-graphify/tsconfig.json packages/tool-graphify/
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/

# Native build deps for better-sqlite3 (only when SQLite backend is used)
RUN apk add --no-cache python3 make g++ && \
    npm ci && \
    apk del python3 make g++

COPY packages/ packages/
COPY apps/ apps/

RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app

RUN addgroup -S kirkforge && adduser -S kirkforge -G kirkforge

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/package.json ./
COPY healthcheck.js ./

# Health check via built-in health server (auth-aware: sends HEALTH_API_KEY as bearer token if set)
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node /app/healthcheck.js

USER kirkforge
EXPOSE 9090

ENV NODE_ENV=production
ENV HEALTH_PORT=9090

ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["serve"]
