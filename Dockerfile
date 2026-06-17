# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Collective Brain — single-container monolith (SPA bundled into the API server)
# Multi-stage: build the client + server, then ship a lean production image.
# ---------------------------------------------------------------------------

# ---- Build stage ----------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app
ENV NODE_ENV=development

# Prisma needs OpenSSL to download/run its query engine.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps with the lockfile (cached unless manifests change).
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
COPY prisma ./prisma
RUN npm ci

# Build client (Vite) + server (tsc).
COPY tsconfig.base.json ./
COPY server ./server
COPY client ./client
RUN npm run build

# ---- Runtime stage --------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Production dependencies only, plus a freshly generated Prisma client.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && npx prisma generate

# Built artifacts.
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

EXPOSE 8080

# Apply pending migrations, then start the server. `migrate deploy` is
# idempotent and uses an advisory lock, so concurrent cold starts are safe.
# (To run migrations as a separate step instead, drop the `migrate deploy &&`
#  and run it from a Cloud Run Job / Cloud Build step — see README.)
CMD ["sh", "-c", "npx prisma migrate deploy && node server/dist/index.js"]
