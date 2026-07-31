# syntax=docker/dockerfile:1
# Task 5.1: multi-stage build for the Colyseus world-server, mirroring
# agent_service/Dockerfile's style (build once, copy only compiled output into the
# runtime stage). Built with context ".." (repo root) + dockerfile "world/Dockerfile",
# same convention agent_service/compose.yaml uses for the "app" service, so the COPY
# paths below are repo-root-relative.

# --- build stage: npm ci (incl. devDependencies) + tsc ---
FROM node:20-slim AS build
WORKDIR /app

# package.json + lockfile first (its own layer for cache reuse). patch-package is a
# devDependency and its "postinstall" script (see world/package.json) patches
# @recast-navigation's .d.ts files -- needed for tsc in this stage, irrelevant at runtime.
COPY world/package.json world/package-lock.json /app/
COPY world/patches /app/patches
RUN npm ci

COPY world/tsconfig.json /app/tsconfig.json
COPY world/src /app/src
RUN npm run build

# --- runtime stage: production deps only + compiled JS ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# --ignore-scripts: skips patch-package's postinstall. Those patches only touch
# @recast-navigation's TypeScript type-declaration files (see world/patches/), which
# tsc needed in the build stage above but the compiled dist/*.js this stage runs never
# reads at runtime -- so runtime has no need to install patch-package itself.
COPY world/package.json world/package-lock.json /app/
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist /app/dist
# world/src/nav/loadFloorPlan.ts resolves data/floor-14.json relative to its own
# compiled module URL (dist/nav/loadFloorPlan.js -> ../../data/floor-14.json -> /app/data).
COPY world/data /app/data

EXPOSE 2567

# world/src/index.ts always registers GET /healthz (unconditionally, before the
# env-gated optional IoT bridge), so this never depends on IoT/MQTT config being set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||2567;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
