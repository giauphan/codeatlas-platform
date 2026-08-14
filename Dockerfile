# syntax=docker/dockerfile:1.7
# Multi-stage build for CodeAtlas Platform — runtime image contains only production deps + compiled output.

# ─── Builder stage ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install pnpm via Corepack
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy lockfile + manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/pnpm-lock.yaml* ./dashboard/

# Install all deps (including devDeps for build)
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN pnpm run build

# Build dashboard
RUN cd dashboard && pnpm run build

# Prune to production deps only
RUN pnpm prune --prod

# ─── Runtime stage ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# Create non-root user (UID/GID 10001)
RUN groupadd --system --gid 10001 codeatlas \
 && useradd  --system --uid 10001 --gid codeatlas --create-home --home-dir /home/codeatlas codeatlas

# Install Oracle Instant Client (Thick mode) + tini for PID 1 signal handling
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libaio1t64 \
      unzip \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/oracle \
 && curl -sL "https://download.oracle.com/otn_software/linux/instantclient/1919000/instantclient-basiclite-linux.x64-19.19.0.0.0dbru.zip" -o /tmp/ic.zip \
 && unzip -q /tmp/ic.zip -d /opt/oracle/ \
 && rm /tmp/ic.zip \
 && echo /opt/oracle/instantclient_19_19 > /etc/ld.so.conf.d/oracle-instantclient.conf \
 && ldconfig

ENV LD_LIBRARY_PATH=/opt/oracle/instantclient_19_19:${LD_LIBRARY_PATH}
ENV NODE_ENV=production
ENV PORT=3381

WORKDIR /app

# Copy built output + production deps from builder
COPY --from=builder --chown=codeatlas:codeatlas /app/node_modules ./node_modules
COPY --from=builder --chown=codeatlas:codeatlas /app/dist ./dist
COPY --from=builder --chown=codeatlas:codeatlas /app/dashboard/dist ./dashboard/dist
COPY --chown=codeatlas:codeatlas package.json ./
COPY --chown=codeatlas:codeatlas .env.example ./

USER codeatlas

EXPOSE 3381

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3381)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
