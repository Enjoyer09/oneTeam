# ==============================================================================
# oneTeam Web Portal — Multi-Stage Production Dockerfile
# ==============================================================================

# Stage 1: Build React/Vite production assets
FROM node:20-alpine AS builder

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
# That is why these are ARGs and not runtime environment variables. They are
# also why the portal shows demo data when they are omitted: with no Supabase
# URL, the client falls back to its built-in mock store.
#
# The anon key is a public, browser-shipped credential by design; row-level
# security in the database is what actually protects the data. The service-role
# key bypasses that protection and must never be passed here.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_API_BASE_URL=""

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
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

# Copy custom enterprise Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
