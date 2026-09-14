# ==============================================================================
# oneTeam Web Portal — Multi-Stage Production Dockerfile
# ==============================================================================

# Stage 1: Build React/Vite production assets
# Node 22, not 20 — see apps/api/Dockerfile. .nvmrc pins 22, and several
# workspace dependencies declare `engines: { node: ">=22" }`.
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests and install dependencies
COPY package*.json ./
RUN npm ci || npm install

# ------------------------------------------------------------------------------
# Build-time configuration for the compiled SPA
# ------------------------------------------------------------------------------
# Vite does not read environment variables at run time. It substitutes every
# `VITE_*` reference into the JavaScript bundle while building, so the values
# have to be present *here*, at image build time — setting them on the running
# container changes nothing.
#
# Only one is left. There used to be two more, `VITE_SUPABASE_URL` and
# `VITE_SUPABASE_ANON_KEY`, threaded through this file and the compose file with
# empty defaults. Nothing in `src/` has read either of them since the portal was
# pointed at the API, and their empty defaults were load-bearing in the worst
# way: they are what the old Supabase client used to decide it had no backend
# and render a built-in mock. A build argument that silently selects a mock is
# not configuration, it is a trap.
#
# The API base URL is a browser-visible address, so it is public by nature. The
# credential that actually authorises a call never reaches this bundle.
ARG VITE_API_BASE_URL=""

ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Copy application source code and configuration files
COPY . ./

# Build production distribution
RUN npm run build

# Stage 2: Lightweight Nginx server for static asset delivery
FROM nginx:alpine AS runner

# Clean default Nginx welcome assets
RUN rm -rf /usr/share/nginx/html/*

# Copy built distribution assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy the Nginx configuration as a TEMPLATE, not as a finished config.
#
# The official nginx image runs envsubst over /etc/nginx/templates/*.template at
# container start and writes the result into /etc/nginx/conf.d/. That is how
# ${API_UPSTREAM} in nginx.conf gets a platform-appropriate value without
# baking a hostname into the image.
#
# NGINX_ENVSUBST_FILTER is load-bearing. Without it, envsubst substitutes EVERY
# defined variable it can see — including nginx's own runtime ones. `$host`,
# `$remote_addr` and `$request_uri` would each be replaced by the empty string,
# silently breaking the proxy headers with no error anywhere.
#
# PORTAL_TOKEN is the PRE-SETUP fallback credential, not the panel's identity.
#
# Before any panel key has been issued the browser has nothing of its own to
# send, and this is what keeps the panel working exactly as it did before logins
# existed. The API honours it only while the panel is unconfigured, so the moment
# the first key is minted it stops being a way in and the login screen becomes
# the only door (see `mayUseRoute` in apps/api/src/common/auth/auth.guard.ts).
#
# The default is the seeded administrator because that is what it takes to mint
# the first key. It is worth replacing with a supervisor once keys are in use,
# and it can be removed altogether once every person who needs the panel has
# their own key — at which point the bootstrap key is the recovery path.
ENV API_UPSTREAM=http://api:3001
ENV PORTAL_TOKEN=oneteam-user:usr-admin-001
ENV NGINX_ENVSUBST_FILTER=^(API_UPSTREAM|PORTAL_TOKEN)$

COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

# Container healthcheck.
#
# Probes 127.0.0.1 rather than `localhost`. In this image `localhost` resolves to
# ::1 first, and a refused IPv6 connection reads as a failed healthcheck even
# while nginx is serving happily on IPv4. An explicit address removes the
# ambiguity; nginx.conf also listens on IPv6 now, so either would work.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
