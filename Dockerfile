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

# The base image is pinned by digest, not by tag.
#
# `node:22-alpine` is a moving target: it followed Alpine to 3.24, and a build using a locally
# cached copy of the older tag failed on `apk add tini` with "v2 database format error" — the
# cached image's package tooling could no longer read the index its repository file pointed at.
# Nothing in this repository had changed. A digest cannot move, so that class of failure cannot
# recur unattended.
#
# To update: `docker pull node:22-alpine` then
# `docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}'`, and change all
# three FROM lines together.
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# ---------------------------------------------------------------------------
# 1. Dependencies
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

RUN corepack enable

# Only the manifests, so this layer is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml ./

# Browsers are for the end-to-end suite, which runs in CI and on a developer's machine — never
# inside this image. Without these two lines pnpm's postinstall pulls roughly 400 MB of Chromium,
# Firefox and WebKit into a build stage that has no display, no test runner and no use for them.
# It was the single largest cost in the build: an earlier attempt sat at "resolved 434, added 433"
# for twenty minutes with nothing to show for it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=1

# --frozen-lockfile: the build fails rather than silently resolving a different tree than the one
# that was tested. A deploy that quietly upgraded a transitive dependency is a deploy nobody can
# reproduce.
#
# The cache mount keeps pnpm's content-addressable store between builds. It is a build-time cache
# only and never becomes a layer, so rebuilds get faster without anything extra reaching the
# shipped image.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
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
ENV NODE_ENV=production
# Traced output, for this image only. See the comment in next.config.ts.
ENV NEXT_STANDALONE=1

# The placeholders are scoped to this one command rather than set as image environment. They are
# not secrets — no real value is known at build time and none is used at runtime — but an ENV
# named SESSION_SECRET is indistinguishable from a real one to anybody reading `docker history`,
# and Docker's own build linter flags it. Something that looks exactly like a leaked secret is a
# bad thing to leave in a build, even when it is not one.
RUN APP_ENV=staging \
    APP_URL=https://build.invalid \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    SESSION_SECRET=build-time-placeholder-not-used-at-runtime-0123456789 \
    pnpm next build

# ---------------------------------------------------------------------------
# 3. Runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
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
# The Prisma client is NOT copied explicitly.
#
# Phase 9 copied node_modules/.prisma, node_modules/@prisma and node_modules/prisma by hand.
# Those paths exist under npm's flat node_modules and do not exist under pnpm, whose store
# symlinks packages from node_modules/.pnpm — so the build failed on the first of them. The
# Dockerfile had never been built, which is the only reason that survived review.
#
# Next's standalone output already traces @prisma/client and its generated engine, because
# next.config.ts lists it in serverExternalPackages. The traced copy comes across with
# .next/standalone above, and the container smoke test below is what proves it.

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
