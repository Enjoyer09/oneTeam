# ==============================================================================
# oneTeam Core API (NestJS) — Production Dockerfile
# ==============================================================================

# Node 22, not 20.
#
# `@nestjs/core` declares `engines: { node: ">=20" }` and `.nvmrc` pins 22, so
# nothing in this project *requires* 22 — but Node 20 reached end-of-life in
# April 2026, and running the API on an unsupported runtime to save nothing is
# not a trade worth making. The pin keeps the image and local development on the
# same major version.
#
# An earlier version of this comment cited `@supabase/supabase-js` and
# `file-type` as the reason. Neither is a dependency any more — the Supabase
# client was removed once the last mock that used it was deleted — so the
# justification was replaced rather than left standing.
FROM node:22-alpine AS builder

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

# ------------------------------------------------------------------------------
# Link the workspace packages BEFORE anything tries to resolve @oneteam/*
# ------------------------------------------------------------------------------
# This has to happen here, not after the build.
#
# `tsc --build` resolves a project reference through node_modules — that is how
# build mode knows a referenced project is already compiled. It does NOT use the
# `paths` mapping for that, unlike a plain `tsc --project` run. So with the links
# created afterwards, the compiler reported:
#
#     error TS2307: Cannot find module '@oneteam/types'
#
# for every import, plus a trail of TS7006 "implicitly has an 'any' type" errors
# that were only consequences of those unresolved modules.
#
# The links are created explicitly rather than relying on npm's workspace
# linking, because at this point each workspace directory contains only its
# package.json.
RUN rm -rf node_modules/@oneteam && \
    mkdir -p node_modules/@oneteam && \
    ln -sfn /app/packages/types node_modules/@oneteam/types && \
    ln -sfn /app/packages/database node_modules/@oneteam/database

# Copy source trees and configs
COPY tsconfig.json ./
COPY packages/types ./packages/types
COPY packages/database ./packages/database
COPY apps/api ./apps/api

# The SQL the API applies at start-up.
#
# `packages/database/src/migrations.ts` walks up from its own compiled location
# looking for `db/api-schema.sql`, so this directory has to sit at the same
# relative depth in the image as it does in the repository. Copying it here and
# not just into the builder is the difference between "migrations run on deploy"
# and "migrations are skipped, and the health endpoint says so".
COPY db ./db

# Build the API together with its workspace dependencies.
#
# `tsc --build` rather than three sequential `tsc --project` calls: the API
# declares project references to packages/types and packages/database, and
# build mode is what makes the compiler honour that ordering itself. Listing
# the projects by hand encoded the same order implicitly — correct until the
# day someone adds a fourth package and does not notice the list needs updating.
RUN node ./node_modules/typescript/bin/tsc --build apps/api/tsconfig.json

# ------------------------------------------------------------------------------
# Stage 2: Lean Production Runtime
# ------------------------------------------------------------------------------
FROM node:22-alpine AS runner

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

# Container healthcheck.
#
# Points at /api/health, which is unauthenticated by design. The previous target
# was /api/tasks, which sits behind AuthGuard: wget received a 401, counted it as
# a failure, and marked a perfectly healthy container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "apps/api/dist/main.js"]
