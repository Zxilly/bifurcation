FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS daemon-build
WORKDIR /src
COPY services/daemon/go.mod services/daemon/go.sum ./
RUN go mod download
COPY services/daemon/ ./
ARG DAEMON_VERSION=0.1.0
COPY deploy/build-daemon.sh /build-daemon.sh
RUN --mount=type=cache,target=/root/.cache/go-build bash /build-daemon.sh

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.4.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/rpc/package.json packages/rpc/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web/ apps/web/
COPY packages/rpc/ packages/rpc/
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build \
    && pnpm --filter @bifurcation/web deploy --prod --legacy /production-web \
    && cd /production-web && node scripts/check-runtime.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ARG VCS_REF=dev
ENV BIFURCATION_REVISION=$VCS_REF
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
ENV BIFURCATION_ARTIFACT_DIRECTORY=/app/artifacts
RUN mkdir -p /data && chown node:node /data
# Preserve Turbopack's hashed external aliases and their traced root targets.
# Our CLI entrypoints also need ordinary package links at the web package root.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
RUN rm -rf /app/apps/web/node_modules
COPY --from=build --chown=node:node /production-web/node_modules ./apps/web/node_modules
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/drizzle ./apps/web/drizzle
COPY --from=build --chown=node:node /app/apps/web/scripts/migrate.mjs ./apps/web/scripts/migrate.mjs
COPY --from=build --chown=node:node /app/apps/web/scripts/admin.mjs ./apps/web/scripts/admin.mjs
COPY --from=build --chown=node:node /app/apps/web/scripts/backup.mjs ./apps/web/scripts/backup.mjs
COPY --from=build --chown=node:node /app/apps/web/scripts/check-runtime.mjs ./apps/web/scripts/check-runtime.mjs
COPY --from=daemon-build --chown=node:node /artifacts /app/artifacts
COPY --chown=node:node deploy/panel-entrypoint.sh /app/panel-entrypoint.sh
COPY --chown=node:node deploy/install.sh /app/deploy/install.sh
USER node
WORKDIR /app/apps/web
RUN node scripts/check-runtime.mjs --standalone
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/panel-entrypoint.sh"]
