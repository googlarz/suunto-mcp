# Dockerfile for Suunto MCP — used by glama.ai's automated checker.
# Multi-stage build: compile TypeScript in builder, ship only runtime files.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# --- Runtime ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Default to stdio MCP transport. Credentials come from the MCP client's
# `env:` block at runtime; the server boots and answers introspection
# (tools/list, resources/list) without them.
ENTRYPOINT ["node", "dist/index.js"]
