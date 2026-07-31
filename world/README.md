# Guide Mate: Virtual World Server

Colyseus authoritative room server for the virtual guide-fleet world. A single `WorldRoom`
simulates a floor of the building (`world/data/floor-14.json`) and everyone in it:
- **Navigation**: a navmesh built with `recast-navigation`, agents moved by its Detour
  Crowd simulation (local avoidance included), one `navigate` command schema in, one
  live route polyline out per agent.
- **Simulated visitors**: ~45 background NPCs (spawn/wander/escort lifecycle) so the
  world reads as a populated building, not an empty stage with a few robots on it.
- **IoT bridge**: an optional MQTT bridge (`world/src/iot/bridge.ts`) that lets the real
  Moses agent dispatch and drive *virtual* fleet robots the same way it dispatches real
  ones, gated entirely behind env vars (see below) -- absent them, the server still
  boots and serves WebSocket clients normally, just without the bridge.
- **Fleet-wide kill switch**: `WorldRoom.pause()`/`resume()` freezes/unfreezes the whole
  simulation (crowd tick + visitor spawner) in one call, driven remotely via the IoT
  bridge from `agent_service`'s admin endpoints (`POST /api/admin/world/stop` /
  `/api/admin/world/resume`).

All of this (Phases 0 through 5 of the implementation plan) is built and reviewed; see
`docs/superpowers/plans/2026-07-26-virtual-world-progress.md` for the task-by-task status
table and `docs/superpowers/plans/2026-07-26-virtual-world-implementation-plan.md` for the
original design.

## Requirements
- Node.js >= 20

## Install

```bash
cd world
npm install
```

`npm install` runs a `postinstall` step that applies `patch-package` patches from
`world/patches/`: `@recast-navigation+core+0.43.1.patch` and
`@recast-navigation+generators+0.43.1.patch`. These fix bare, extensionless import
specifiers in the vendored `@recast-navigation/*` `.d.ts` re-exports, which don't
resolve under this project's `moduleResolution: NodeNext` and break `tsc`/`npm run
build` (runtime behavior is unaffected). If you see patch-package output during
install, that's expected: it's re-applying these two patches, not an error.

## Run (dev)

```bash
npm run dev
```

Starts the server on `http://localhost:2567` (override with `PORT`). It watches
`src/` and restarts on change.

Verify it's up:

```bash
curl http://localhost:2567/healthz
# {"ok":true}
```

## Environment variables

All optional; the server boots and serves WebSocket clients fine with none of them set.

| Var | Purpose |
|---|---|
| `PORT` | HTTP/WebSocket port (default `2567`). |
| `GUIDEMATE_IOT_ENDPOINT` | AWS IoT Core endpoint. Along with `GUIDEMATE_CERT`/`GUIDEMATE_KEY`, all three must be set to start the MQTT bridge; if any is missing it logs and skips the bridge, not an error. |
| `GUIDEMATE_CERT` / `GUIDEMATE_KEY` | Paths to the client cert/private key used to connect to IoT Core. |
| `GUIDEMATE_CA` | Optional CA bundle path. |
| `GUIDEMATE_VIRTUAL_CLIENT_ID` | Optional override for the bridge's MQTT client id. |
| `GUIDEMATE_NAV_TIMEOUT_MS` | Optional override for how long the bridge waits for a `navigate` command to resolve before acking `failed`/`nav_timeout`. |

A present-but-wrong cert/endpoint (as opposed to simply unset) throws inside `mqtt.connect`
or `readFileSync`; `src/index.ts` catches that so a bad IoT config degrades the bridge, not
the whole server.

## Build + run (production-style)

```bash
npm run build
npm start
```

## Deploying

`world/Dockerfile` is a multi-stage build (build with devDependencies + `tsc`, then a slim
runtime image with production deps only). It's wired up as the `world-server` service in
`agent_service/compose.yaml` (dev) and `agent_service/compose.prod.yaml` (prod), built with
context `..` (repo root) so its COPY paths are repo-root-relative. See those compose files
for how the IoT env vars above get passed through in a deployed setup.

## Test

```bash
npm test
```

Boots a throwaway instance of the server on a separate port, joins the `world`
room with a Colyseus client, and asserts the initial state has an empty `agents`
map and a `floor` number. This is a single smoke-test script, not a full test
harness.

```bash
npm run test:nav
```

Runs the navmesh/pathfinding test suite (`src/nav/__tests__/`): floor-plan loading,
navmesh geometry, and navmesh build/pathfinding.

```bash
npm run test:crowd
```

Runs the Detour Crowd simulation tests plus `WorldRoom`'s own test suite (agent movement,
`navigate` command handling, the pause/resume kill switch).

```bash
npm run test:visitors
```

Runs the simulated-visitor spawner/escort-manager tests.

```bash
npm run test:iot
```

Runs the MQTT bridge's unit tests (command parsing/routing, ack/heartbeat topics, the
already-arrived-target fix) against a fake broker, no real network or AWS credentials
needed.

```bash
npm run test:iot:integration
```

A separate, *not* part of `test:all`, integration test that needs a real broker/credentials
to exercise the bridge end to end. Run this one deliberately, not as part of the regular loop.

```bash
npm run test:load
```

Runs `scripts/loadtest.ts`: spins up ~95 simulated agents and measures Crowd-tick time per
frame against the 16.6ms budget. Also not part of `test:all` since it's a timing benchmark,
not a pass/fail unit suite.

```bash
npm run test:all
```

Runs `test`, `test:nav`, `test:crowd`, `test:visitors`, and `test:iot` in sequence. This is
the suite to run before committing; `test:iot:integration` and `test:load` are separate,
deliberate runs (see above).
