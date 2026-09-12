# syntax=docker/dockerfile:1
#
# jovi-mall — three targets: builder · toolbox · runtime.
#
# ═══ THE RUNTIME IMAGE CANNOT RUN A MIGRATION, AND THAT IS WHY `toolbox` EXISTS ═══
#
# `npm run build` is `tsc` (rootDir src/, outDir dist/) plus an asset copy. It emits
# `src/` and nothing else — the fifteen migration and backfill programs under
# `scripts/` are never compiled, and they are invoked through `ts-node`, which reaches
# this tree only as a devDependency. A runtime image built with `npm ci --omit=dev`
# therefore has no way to run one. Baking devDependencies into it to fix that would
# put the whole toolchain on the internet-facing service.
#
# So `toolbox` is a separate target off the same `builder`: same source, same lockfile,
# same compiled output, with devDependencies kept. Migrations run as
#
#     docker compose run --rm jovi-mall-toolbox npm run migrate:up
#
# which is byte-identical to the migration under test. This is plan decision D-5.
#
# ═══ THE BASE IS DEBIAN, DELIBERATELY (D-4) ══════════════════════════════════════
#
# Alpine would in fact work: `bcrypt@6` ships prebuilds inside the npm package for
# both linux-x64 glibc AND musl, and `sharp@0.35`'s platform binaries arrive as
# `@img/sharp-linuxmusl-x64` from the lockfile — so neither native module needs a
# compiler on either libc. Debian is a risk budget, not a requirement: two native
# modules on a musl path is the less-travelled route for a first deploy, and
# geo-tracker's alpine image is a static Go binary, which is no precedent for a Node
# one. About 40 MB is the price.
#
# ═══ NODE 22 IS PINNED IN THREE PLACES, AND THEY MUST AGREE (ADR-019 D-1) ════════
#
#   1. this file's `FROM`
#   2. `package.json` → `engines.node`
#   3. `.github/workflows/ci.yml` → `NODE_VERSION`
#
# It is not only policy: `firebase-admin@14` declares `engines: { node: ">=22" }`, so
# a direct dependency enforces the floor.

# ═════════════════════════════════════════════════════════════════════════════════
#  builder — full toolchain, compiles src/ → dist/
# ═════════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# NODE_ENV is deliberately NOT set to production here: npm 8+ reads it and would
# quietly omit the devDependencies this stage exists to use.

# Lockfile first, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts ./scripts

# ⚠ NOT A TUNING KNOB — this build does not complete without it on a small machine.
# `ci.yml` died at `Type-check src` with exit 134 on EVERY run from 2026-08-18 until the
# deploy drill: `FATAL ERROR: Ineffective mark-compacts near heap limit`. The exit carries
# no TypeScript diagnostic, so it reads as a broken type-check rather than as a memory
# ceiling — see docs/RUNBOOK.md § "Found 3". `npm run build` below is that same `tsc`.
#
# V8 sizes its default old-space from the memory it can see, so this passes on a large CI
# runner and fails on an 8 GB VPS, which is the worst of both: green in CI, red only where
# it matters. Pinned here so the number travels with the build instead of living in one
# workflow file.
ENV NODE_OPTIONS=--max-old-space-size=4096

# `tsc` + `copy-build-assets.ts`. The second half is not optional: tsc emits `.js`
# and imported `.json` and nothing else, so the six Handlebars mail templates that
# `mail.service.ts` reads from `__dirname/templates` would be absent from dist/ and
# every templated email would throw MAIL_TEMPLATE_NOT_FOUND in this image.
RUN npm run build

# ═════════════════════════════════════════════════════════════════════════════════
#  toolbox — migrations, backfills and the DB-backed verify:* suites (D-5)
# ═════════════════════════════════════════════════════════════════════════════════
FROM builder AS toolbox

# Runs as root on purpose. This is a `run --rm` maintenance container, never a
# listening service: it holds no port, lives for one command, and some migration
# scripts write a report beside themselves. Chowning /app to `node` would also copy
# every node_modules file into a new layer for no security gain here.

# This stage DECLARES no entrypoint, and must not. The documented invocation passes
# the whole command — `docker compose run --rm jovi-mall-toolbox npm run migrate:up` —
# which overrides CMD but NOT an entrypoint; with `ENTRYPOINT ["npm","run"]` that line
# would expand to `npm run npm run migrate:up`.
#
# The image still REPORTS `Entrypoint: ["docker-entrypoint.sh"]`, inherited from the
# official node image. That is harmless and worth knowing rather than rediscovering:
# the script `exec "$@"`s whatever it is handed, which is also why the runtime stage's
# node ends up as PID 1 and receives SIGTERM.
#
# `npm run` with no argument prints the script list — the useful default for a
# container whose whole job is running one of them. `migrate:status` arrives in plan
# step 2.C; naming it here before it exists would make the image's default a 404.
CMD ["npm", "run"]

# ═════════════════════════════════════════════════════════════════════════════════
#  runtime — the deployed service. LAST stage, so it is the default build target.
# ═════════════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# A second, clean production install rather than pruning the builder's tree: npm ci
# deletes and rebuilds node_modules from the lockfile, so the result cannot carry a
# stale devDependency that `npm prune` left behind. The platform binaries for
# `bcrypt` and `sharp` are resolved HERE, on linux/amd64, which is the whole reason
# `node_modules` is in `.dockerignore`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Mountpoint for the uploads volume (D-6). Two independent code paths resolve this
# directory and they agree ONLY because WORKDIR is the application root:
#   • `local-storage.provider.ts` writes to `STORAGE_LOCAL_PATH ?? './storage'`,
#     which is relative to the process CWD.
#   • `api/index.ts` serves `path.join(__dirname, '../..', 'storage')`, which from
#     `/app/dist/api` is also `/app/storage`.
# Running this image with a different working directory splits reads from writes.
RUN mkdir -p /app/storage && chown -R node:node /app/storage

USER node

EXPOSE 8022

# HEALTHCHECK IS NOT A READINESS PROBE. They answer different questions, they act on
# different verbs, and conflating them is the whole of X-6:
#
#   • Docker's HEALTHCHECK asks "is this container's process alive" — the answer drives
#     a RESTART. A dependency has no business in it: restarting this process does not
#     fix somebody else's database, and a dependency outage must not become a restart
#     loop. That is `/api/health/live`, which touches nothing.
#   • Readiness asks "should this instance receive traffic" — the answer drives
#     DEPOOLING, which an instance rejoins by itself. That is `/api/health/ready`, and
#     it belongs in the orchestrator's config, not here.
#
# This points at `/api/health/live` rather than the frozen `/api/health`, deliberately
# (plan step 2.B.5). Both are unconditional 200s that touch nothing, so either would
# work — but `/api/health` is already a wire contract with geo-tracker AND wi-admin,
# and `/live` is the endpoint whose actual job this is. One fewer consumer on a frozen
# path is worth having.
#
# NEVER point a readiness check at `/api/health`. geo-tracker's `NodeAPIChecker`
# already registers that path as a *readiness* check and its client treats any status
# ≥ 300 as an error, so readiness semantics there mean a jovi-mall Redis wobble pulls
# geo-tracker out of rotation and kills every live WebSocket tracking session — for a
# fault in a service that is itself healthy. See `api/routes/health.routes.ts` and
# ADR-014 D-1. `curl` and `wget` are both absent from bookworm-slim, so the probe uses
# the runtime that is certainly present.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8022,path:'/api/health/live'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# EXEC form, not shell form. Shell form would run `/bin/sh -c "node …"`, putting sh
# at PID 1 where it neither forwards SIGTERM nor exits on it — and the entire graceful
# drain built in plan step 2.A hangs off `process.on('SIGTERM')` in `lifecycle.ts`.
# Docker would then SIGKILL after its grace period, severing in-flight requests and
# leaving a worker's Redis lock held until its PX expiry: precisely the failure 2.A
# exists to remove.
CMD ["node", "dist/server.js"]
