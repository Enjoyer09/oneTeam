# ==============================================================================
# oneTeam Web Portal — Production Dockerfile (apps/web alias)
# ==============================================================================

# Stage 1: Build React/Vite production assets
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests and install dependencies
COPY package*.json ./
RUN npm ci || npm install

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
