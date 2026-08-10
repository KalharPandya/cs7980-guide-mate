# syntax=docker/dockerfile:1
# Multi-stage build for the Three.js / React-Three-Fiber world-client, mirroring
# world/Dockerfile's style (do the whole toolchain in a throwaway build stage, ship only the
# output). Built with context ".." (repo root) + dockerfile "world-client/Dockerfile", the same
# convention agent_service/compose.yaml already uses for "app" and "world-server", so every COPY
# path below is repo-root-relative.

# --- build stage: npm ci (incl. devDependencies) + tsc + vite build ---
FROM node:20-slim AS build
WORKDIR /app

# package.json + lockfile first, in their own layer, so a source-only edit does not re-run the
# install. Unlike world/Dockerfile there are no patches/ to copy: this package has no
# patch-package postinstall.
COPY world-client/package.json world-client/package-lock.json /app/
RUN npm ci

# Sub-path this build is served from. It sets vite.config.ts's `base`, which drives BOTH the
# asset URLs written into index.html AND import.meta.env.BASE_URL, which src/assetUrl.ts uses to
# resolve the runtime public/ fetches (floor-plan JSON, GLB models) that a bundler cannot rewrite
# on its own. It MUST stay in lockstep with the /viz/* route in agent_service/Caddyfile: the edge
# strips the prefix and this base puts it back on, so changing one alone breaks every asset.
ARG VITE_BASE_PATH=/viz/

# Colyseus endpoint the BROWSER dials (see src/net/useWorldRoom.ts). Baked in at build time
# because Vite inlines import.meta.env.* into the bundle -- there is no runtime env in a static
# build. agent_service/compose.yaml passes the real value, derived from GUIDEMATE_DOMAIN, so the
# production domain is never hardcoded in this repo. The default here is only a safety net for a
# bare `docker build` with no args, and points at the same ws://localhost:2567 that
# useWorldRoom.ts already falls back to for local dev.
ARG VITE_WORLD_SERVER_URL=ws://localhost:2567

# Google Cloud Maps API key for the Photorealistic 3D Tiles backdrop (see src/scene/GoogleTiles.tsx
# and src/App.tsx). Baked in at build time like the two ARGs above, because Vite inlines
# import.meta.env.* into the static bundle -- there is no runtime env for a static build. Default is
# EMPTY on purpose: with no key App.tsx falls back to the procedural Skyline, so a bare `docker
# build` with no args still produces a working image. agent_service/compose.yaml passes the real
# value from GOOGLE_MAPS_API_KEY in /etc/guidemate.env.
ARG VITE_GOOGLE_MAPS_API_KEY=

# Vite's loadEnv() picks VITE_-prefixed vars straight out of the process environment (no .env
# file needed), and vite.config.ts reads VITE_BASE_PATH from process.env directly, so promoting
# these ARGs to ENV is what actually gets them into the build.
ENV VITE_BASE_PATH=${VITE_BASE_PATH} \
    VITE_WORLD_SERVER_URL=${VITE_WORLD_SERVER_URL} \
    VITE_GOOGLE_MAPS_API_KEY=${VITE_GOOGLE_MAPS_API_KEY}

COPY world-client/tsconfig.json world-client/vite.config.ts world-client/index.html /app/
COPY world-client/src /app/src
COPY world-client/public /app/public
# `npm run build` is `tsc && vite build`: the type-check is part of the image build on purpose,
# so a type error fails the build here rather than shipping a silently-stale bundle.
RUN npm run build

# --- runtime stage: static file server, no Node ---
# caddy:2 rather than nginx:alpine for two reasons. First, the stack ALREADY pulls caddy:2 for
# the edge proxy (agent_service/compose.yaml), so this adds zero new images to fetch, cache, or
# patch on the host, and one Caddyfile syntax for anyone debugging routing. Second, the two
# things a sub-path SPA needs -- a try_files fallback and compression -- are one line each in
# Caddy with no sites-enabled/mime-type boilerplate. Nothing here needs Node at runtime; the
# output is plain static files.
FROM caddy:2 AS runtime

COPY --from=build /app/dist /srv
COPY world-client/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080

# Matches how `app` and `world-server` health-check (an in-container HTTP GET of their own
# health endpoint). /healthz is served by the Caddyfile above, independent of the built assets.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/healthz || exit 1

# No CMD: the caddy image's own default (`caddy run --config /etc/caddy/Caddyfile --adapter
# caddyfile`) already runs the Caddyfile copied above, and restating it would just be one more
# thing to drift out of sync with the base image.
