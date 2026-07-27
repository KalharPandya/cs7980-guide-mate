# Guide Mate — Virtual World Server

Bare Colyseus authoritative room server for the virtual guide-fleet world. This is the
Task 0.1 scaffold only: a `WorldRoom` with an empty `agents` map and a `floor` number.
No navigation, no IoT bridge, no simulated visitors yet -- those land in later tasks
(see `docs/superpowers/plans/2026-07-26-virtual-world-implementation-plan.md`).

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

## Build + run (production-style)

```bash
npm run build
npm start
```

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
navmesh geometry, and navmesh build/pathfinding. `npm test` alone does not run
these, they're a separate script.

```bash
npm run test:all
```

Runs both suites in sequence (`npm test`, then `npm run test:nav`).
