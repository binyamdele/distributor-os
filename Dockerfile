# The pilot image.
#
# One container, one process, against a managed PostgreSQL and an S3-compatible bucket. Chosen
# over a serverless target because every concurrency guarantee in Phases 4 to 7 rests on real
# transactions holding real row locks, and a connection model that recycles between statements
# fights that design rather than supporting it.
#
# Multi-stage, so the shipped image carries no build toolchain, no dev dependencies and no source
# — a smaller attack surface and a faster cold start, both of which matter more than the few
# minutes the extra stage costs.

# ---------------------------------------------------------------------------
# 1. Dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable

# Only the manifests, so this layer is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: the build fails rather than silently resolving a different tree than the one
# that was tested. A deploy that quietly upgraded a transitive dependency is a deploy nobody can
# reproduce.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Injected at build time and baked into the image, so a running container can say exactly which
# commit it is. "Which version are you running" is the first question on every support call, and
# it currently has an answer only because of these two lines.
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME

RUN pnpm prisma generate

# `next build` runs the config module. The production guards would refuse a build environment
# that has no real secret or bucket, so the build is told it is staging: it needs to compile
# pages, not to be a valid production deployment. The real settings arrive at runtime and are
# validated then, which is where they matter.
ENV APP_ENV=staging
ENV NODE_ENV=production
ENV APP_URL=https://build.invalid
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV SESSION_SECRET=build-time-placeholder-not-used-at-runtime-0123456789
# Traced output, for this image only. See the comment in next.config.ts.
ENV NEXT_STANDALONE=1
RUN pnpm next build

# ---------------------------------------------------------------------------
# 3. Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# tini gives the container a real init: it reaps zombies and, more importantly here, forwards
# SIGTERM to Node. Without it PID 1 is Node itself with default signal handling, and a deploy's
# graceful-shutdown window is spent waiting for a process that never received the signal.
RUN apk add --no-cache tini

# Never root. A container escape is a much smaller problem when the process inside owns nothing.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Next's standalone output: the server plus only the dependencies it actually reached for.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# No `public/` copy: this project has no static asset directory, and Phase 9 shipped a
# Dockerfile that assumed one. It had never been built — the first `docker build` failed on
# exactly this line. Next only emits `public/` into the standalone output when it exists.

# Migrations and the Prisma schema travel with the image, so the deploy runs exactly the
# migrations that were built and tested together with the code — not whatever is on a branch.
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma

ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_TIME=$BUILD_TIME

USER nextjs
EXPOSE 3000

# Liveness only. Readiness is the platform's job to poll, because a container whose database is
# briefly unreachable should be taken out of rotation — not killed and restarted, which turns a
# recoverable dependency outage into a restart storm.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
