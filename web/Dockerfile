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

# ------------------------------------------------------------------------------
# Privilege posture
# ------------------------------------------------------------------------------
# nginx already splits its privileges: the master process runs as root only so
# it can bind the privileged port 80, and it immediately drops the worker
# processes — the ones that actually parse requests and touch the network — to
# the unprivileged `nginx` user declared by `user nginx;` in the base image's
# /etc/nginx/nginx.conf. A `USER nginx` line here would instead make the master
# run as nginx too, and it would then fail to bind port 80 and could not write
# its pid file, so the container would not start.
#
# A fully rootless image is possible with `nginxinc/nginx-unprivileged`, but it
# listens on 8080 rather than 80, which means editing web/nginx.conf and the
# published-port/healthcheck wiring. That config file is owned by another part
# of the project, so the rootless switch is left as a documented follow-up
# rather than a half-applied change. The request-handling workers are already
# non-root today.

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
# PORTAL_TOKEN — the OPTIONAL pre-setup fallback credential.
#
# No default is baked in any more. The image used to ship
# `ENV PORTAL_TOKEN=oneteam-user:usr-admin-001`, a credential anyone who reads
# this repository can replay, valid until the first panel key is minted. With
# ONETEAM_SERVICE_SIGNING_SECRET now required, the unsigned shape is rejected
# by the API anyway — the baked value is dead weight and a trap.
#
# First login now goes through the API's bootstrap key instead: set
# ONETEAM_PANEL_BOOTSTRAP_KEY on the api service, sign in with it once, mint
# personal keys, then remove it. A deployment that still wants the edge
# fallback can set PORTAL_TOKEN at runtime (a SIGNED, freshly minted token);
# the nginx map leaves the Authorization header absent when it is unset, which
# is the normal, fully configured state.
ENV API_UPSTREAM=http://api:3001
# Defined-but-empty ON PURPOSE. The envsubst hook only substitutes variables
# that exist in the environment; an unset PORTAL_TOKEN would leave the literal
# ${PORTAL_TOKEN} in nginx.conf and nginx crash-loops on the unknown variable.
# Empty substitutes to `map ""` — no fallback header, the normal locked state.
ENV PORTAL_TOKEN=""
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
