# Vaulltcore Dockerfile - Multi-stage build for Fly.io deployment
# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare npm@latest --activate
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/*/package.json ./packages/
RUN npm ci --ignore-scripts
COPY . .

# Stage 2: Build
FROM deps AS build
RUN npm run typecheck

# Stage 3: Production
FROM node:22-alpine AS production
RUN corepack enable && corepack prepare npm@latest --activate
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/*/node_modules

# Copy source files
COPY package.json ./
COPY packages ./packages

# Create a non-root user
RUN addgroup -g 1001 -S vaulltcore && \
    adduser -S vaulltcore -u 1001

# Set ownership
RUN chown -R vaulltcore:vaulltcore /app

USER vaulltcore

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Start the control plane
CMD ["node", "--import", "tsx", "packages/vaulltcore-control/src/serve.ts"]
