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

# Copy workspace package manifests.
#
# Only package*.json is copied now. The old `pnpm-workspace.yaml*` and
# `turbo.json*` globs were removed when those files were deleted from the
# repository (npm workspaces is the only monorepo tool in use; turbo was never
# installed and turbo.json used the deprecated "pipeline" key). The trailing `*`
# made them optional, so their removal does not change the build — the lines are
# gone to stop implying a tool that is not here.
COPY package*.json ./
COPY packages/types/package*.json ./packages/types/
COPY packages/database/package*.json ./packages/database/
COPY apps/api/package*.json ./apps/api/

# Install all workspace dependencies.
#
# `npm ci`, not `npm install`: ci installs exactly what package-lock.json pins
# and fails loudly if the lockfile is out of sync, so the image is built from
# the same dependency tree that was reviewed. `npm install` can quietly mutate
# resolution, which is the one thing a production build must not do.
RUN npm ci

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
# relative depth in the image as it does in the repository.
#
# Kept in the builder as well as the runtime stage, because the builder is where
# `tsc --build` runs and a missing file here would be confusing to diagnose.
# **The runtime copy is the load-bearing one** — see the runner stage.
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

# ------------------------------------------------------------------------------
# Drop devDependencies from the runtime image.
# ------------------------------------------------------------------------------
# The builder installs the full tree (it needs typescript/tsx and @types to
# compile), and the line above copies that tree wholesale — so without this the
# production image shipped the TypeScript compiler and the rest of the dev
# toolchain, bloating it and putting a compiler in the runtime attack surface.
# `npm prune --omit=dev` removes the devDependencies in place; the workspace
# packages (@oneteam/types, @oneteam/database) are declared workspaces, not
# extraneous, so their symlinks survive. NODE_ENV=production (set above) makes
# the omit the default, but it is named explicitly so the intent does not depend
# on an env var. The bot image already does the equivalent.
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# The schema, migrations and seed data — and this line is not optional
# ------------------------------------------------------------------------------
# Without it the image contains no `db/` directory, so `findRepoRoot()` walks up
# from `/app/packages/database/dist`, finds no `db/api-schema.sql` within its
# eight levels, returns null, and `runMigrations()` gives up before reading a
# single file. The API still boots, serves, and reports:
#
#     "schema": { "ok": false, "detail": "Could not locate the repository root
#                 (no db/api-schema.sql found above /app/packages/database/dist).
#                 Migrations were NOT applied." }
#
# Which is exactly what the health endpoint is for — but nobody reads a health
# endpoint that says "ok" at the top level, and the deployment this matters for
# is the one where it is the *only* thing creating the schema. The compose file
# mounts `db/api-schema.sql` into Postgres's initdb directory, but that only
# applies to a self-hosted Postgres on a fresh volume. On a managed database —
# Railway, RDS, Neon — the API's start-up migration is the only mechanism there
# is, and `ONETEAM_AUTO_MIGRATE` defaults to on precisely so it works.
#
# Found by building the image and running it rather than by reading this file:
# `/app/db` was absent, and four migrations — including the ones that add
# `mobile_device_id`, `device_tokens`, `data_version` and `panel_tokens` — had
# never been applied by any container.
COPY --from=builder /app/db ./db

# Expose API port
EXPOSE 3001

# ------------------------------------------------------------------------------
# Drop privileges — run as the unprivileged `node` user, not root.
# ------------------------------------------------------------------------------
# The node:22-alpine image ships a `node` user (uid 1000) for exactly this. The
# API needs only to read its own files (compiled JS, node_modules and the db/
# SQL it applies at start-up), all of which COPY leaves world-readable, so no
# chown is required. Photos are stored inline in the database by default, so the
# runtime writes nothing to the image filesystem. Running as root would hand a
# compromised process the run of the container for no operational gain.
USER node

# Container healthcheck.
#
# Points at /api/health, which is unauthenticated by design. The previous target
# was /api/tasks, which sits behind AuthGuard: wget received a 401, counted it as
# a failure, and marked a perfectly healthy container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

CMD ["node", "apps/api/dist/main.js"]
