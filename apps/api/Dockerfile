# ==============================================================================
# oneTeam Core API (NestJS) — Production Dockerfile
# ==============================================================================

# Stage 1: Build workspace packages and NestJS application
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools
RUN apk add --no-cache python3 make g++

# Copy workspace package manifests
COPY package*.json pnpm-workspace.yaml* turbo.json* ./
COPY packages/types/package*.json ./packages/types/
COPY packages/database/package*.json ./packages/database/
COPY apps/api/package*.json ./apps/api/

# Install all workspace dependencies
RUN npm install

# Copy source trees and configs
COPY tsconfig.json ./
COPY packages/types ./packages/types
COPY packages/database ./packages/database
COPY apps/api ./apps/api

# Build the API together with its workspace dependencies.
#
# `tsc --build` rather than three sequential `tsc --project` calls: the API
# declares project references to packages/types and packages/database, and
# build mode is what makes the compiler honour that ordering itself. Listing
# the projects by hand encoded the same order implicitly — correct until the
# day someone adds a fourth package and does not notice the list needs updating.
RUN node ./node_modules/typescript/bin/tsc --build apps/api/tsconfig.json

# Ensure workspace packages are symlinked in node_modules
RUN mkdir -p node_modules/@oneteam && \
    ln -sf /app/packages/types node_modules/@oneteam/types && \
    ln -sf /app/packages/database node_modules/@oneteam/database

# Stage 2: Lean Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV API_PORT=3001

# Copy dependency manifests
COPY package*.json ./
COPY packages/types/package*.json ./packages/types/
COPY packages/database/package*.json ./packages/database/
COPY apps/api/package*.json ./apps/api/

# Copy built node_modules and compiled artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Expose API port
EXPOSE 3001

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/tasks || exit 1

CMD ["node", "apps/api/dist/main.js"]
