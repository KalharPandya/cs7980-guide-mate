# Virtual World Guide Fleet — Implementation Plan

Design reference: `docs/superpowers/specs/2026-07-26-virtual-world-guide-fleet-design.md`
Branch: `feat/kalhar-virtual-world` (isolated worktree at
`.claude/worktrees/feat+kalhar-virtual-world`)
Execution method: subagent-driven-development, all subagents on Sonnet 5, two-stage review
(spec compliance then code quality) per task, independent tasks dispatched in parallel.

## How to resume this if the session resets
1. Read this file and the design spec above.
2. Read `docs/superpowers/plans/2026-07-26-virtual-world-progress.md` for live status (task
   statuses, what's committed, what's in flight, open questions).
3. Re-enter the worktree (`EnterWorktree` with `path: .claude/worktrees/feat+kalhar-virtual-world`,
   or `cd` there directly) and continue from the first `pending` task in the progress file.

## Task list

### Phase 0 — Scaffolding and floor data

**Task 0.1 — Colyseus world-server scaffold** (independent, parallel-safe)
Files: `world/package.json`, `world/tsconfig.json`, `world/src/index.ts`,
`world/src/rooms/WorldRoom.ts`, `world/src/rooms/schema/WorldState.ts`.
Requirements:
- Node >=20, ESM (`"type": "module"` in package.json). TypeScript.
- Dependencies: `colyseus` 0.17.10, `@colyseus/schema` 4.0.30, `@colyseus/ws-transport`,
  `express` (Colyseus needs an HTTP server to attach to), `@colyseus/tools` if it simplifies
  bootstrap, dev deps `typescript`, `ts-node` or `tsx`, `@types/node`.
- `WorldState` schema (in `schema/WorldState.ts`): a `MapSchema` of a minimal `Agent` schema
  (`id: string, x: number, z: number, heading: number, kind: "robot"|"visitor", state: string`)
  called `agents`, plus `floor: number`.
- `WorldRoom` (extends Colyseus `Room<WorldState>`): `onCreate` sets `this.setState(new WorldState())`,
  logs "WorldRoom created", `onJoin`/`onLeave` just log for now (no schema-per-connection auth yet
  -- that's Phase 4). No navigation logic yet -- that's Task 1.1, a separate task, don't add it here.
- `index.ts`: boots an Express app, attaches Colyseus `Server` with `WebSocketTransport`, defines
  the room with `gameServer.define('world', WorldRoom)`, listens on `process.env.PORT || 2567`,
  and exposes a plain `GET /healthz` returning `{ ok: true }`.
- A README in `world/` with `npm install` + `npm run dev` instructions.
- Test: a script or a minimal test (Jest or Node's built-in test runner, whichever is lighter to
  wire up) that boots the server, connects a Colyseus client (`colyseus.js` or `@colyseus/sdk`),
  joins the `world` room, and asserts it received an initial state with `agents` empty and
  `floor` present. Keep this ONE test -- don't build a full test harness yet.
Acceptance: `npm install && npm run dev` starts cleanly, `curl localhost:2567/healthz` returns
`{"ok":true}`, the join test passes.
Explicitly NOT in scope for this task: navigation/recast (Task 1.1), IoT bridge (Task 2.x),
simulated visitors (Task 4.x). Keep `WorldRoom` a bare skeleton.

**Task 0.2 — Three.js/R3F client scaffold** (independent, parallel-safe)
Files: `world-client/package.json`, `world-client/vite.config.ts`, `world-client/index.html`,
`world-client/src/main.tsx`, `world-client/src/App.tsx`, `world-client/tsconfig.json`.
Requirements:
- Vite + React 19 (required by `@react-three/fiber` 9.6.1) + TypeScript.
- Dependencies: `three` 0.185.1, `@react-three/fiber` 9.6.1, `@react-three/drei` 10.7.7,
  `@colyseus/sdk` 0.17.x (pin to match the server's 0.17 line -- do NOT use the old `colyseus.js`
  package name, it was renamed in 0.17).
- `App.tsx`: an R3F `<Canvas>` with a simple placeholder scene -- a large `MeshStandardMaterial`
  ground plane in a neutral grey (`#8a8a8a`, `roughness: 0.95`) to stand in for the carpet later,
  one `ambientLight` + one `directionalLight`, and drei `<MapControls>` for camera navigation.
  No models, no Colyseus connection yet -- this task is just "does R3F render in a browser."
- Confirm it runs via `npm run dev` and actually renders (use the browser preview tool to load it
  and take a screenshot as your verification -- don't just check the build compiles).
Acceptance: `npm install && npm run dev`, preview in browser shows a grey ground plane and
responds to mouse drag/zoom (MapControls working). Screenshot attached to your report.

**Task 0.3 — Floor-plan data (DONE, controller-authored)**
`world/data/floor-14.json` already exists (written by the controller directly, since it required
reading the pasted floor-plan images that only the controller session had access to). Nothing to
do here -- later tasks (1.1 navmesh, 3.x renderer geometry) consume this file as-is. If a later
task finds the schema doesn't quite fit its needs, flag it as a concern rather than silently
changing the file -- the controller owns edits to this specific file.

**Task 0.4 — CC0 asset fetch script** (independent, parallel-safe)
Files: `world/scripts/fetch_assets.sh`, assets land in `world-client/public/models/` and
`world-client/public/textures/` (create these dirs).
Requirements: a bash script, safe to re-run (skip-if-exists), that downloads:
- `world-client/public/models/robot.glb` from
  `https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb`
- Kenney Furniture Kit zip from `https://kenney.nl/assets/furniture-kit` -- the direct .zip URL
  embeds a version hash that rotates, so the script must fetch the asset page HTML and regex/grep
  the `.zip` href out of it, then curl that URL, unzip into `world-client/public/models/furniture/`,
  and keep only the `.glb` files (drop FBX/OBJ/DAE/STL to save repo space). Verify the license
  file in the zip says CC0 and copy it alongside as `world-client/public/models/furniture/LICENSE.txt`.
- One Quaternius CC0 human via poly.pizza: the model page is
  `https://poly.pizza/m/c3Ibh9I3udk` and the direct GLB is
  `https://static.poly.pizza/170235d2-cdeb-4cb2-a82f-4828585138fe.glb` -- curl this directly to
  `world-client/public/models/visitor.glb` (this ID was confirmed to resolve and to embed 8
  animation clips including Idle/Walk during this project's research; if it 404s, fall back to
  fetching `https://poly.pizza/m/c3Ibh9I3udk`, find the current `static.poly.pizza` link in the
  page, and use that instead -- note in your report if you had to do this).
- Add a `.gitattributes` or note in `world-client/public/models/README.md` that these are binary
  CC0 assets, with attribution lines for Kenney (kenney.nl) and Quaternius/Don McCurdy
  (three.js RobotExpressive, CC0).
Acceptance: running the script twice is a no-op the second time (idempotent), all three assets
land at the paths above, `world-client/public/models/README.md` documents source + license for
each. Verify each downloaded GLB is non-empty and starts with the glTF binary magic (`glTF` in the
first 4 bytes) -- don't just trust the HTTP status code.

### Phase 1 — Server world and navigation (headless)

**Task 1.1 — Navmesh generation from floor-plan JSON** (depends on 0.1 existing; independent of 0.2/0.4)
Files: `world/src/nav/buildNavMesh.ts`, `world/src/nav/loadFloorPlan.ts`, tests under
`world/src/nav/__tests__/`.
Requirements:
- `loadFloorPlan.ts`: loads and validates `world/data/floor-14.json` against a TypeScript type
  matching its schema (`walkableOutline`, `holes`, `walls`, `rooms`, `entrance`).
- `buildNavMesh.ts`: using `recast-navigation` 0.43.1 (`init()`, `generateSoloNavMesh` from
  `recast-navigation/generators`) and `earcut` 3.2.3:
  1. Triangulate `walkableOutline` with `holes` via earcut to get floor triangles at y=0.
  2. For each entry in `walls`, emit a vertical quad (2 triangles) from y=0 to y=`height`,
     honoring right-handed/CCW winding as the recast-navigation README specifies.
  3. Concatenate all positions/indices, call `generateSoloNavMesh(positions, indices, config)`.
     Use a small cell size (`cs: 0.1`, `ch: 0.1`) so 1.2m door gaps resolve; derive
     `walkableRadius`/`walkableHeight`/`walkableClimb` from meters using this `cs`/`ch` (these
     three plus `maxEdgeLen`/`borderSize`/`tileSize` are VOXEL counts, not meters -- get this
     wrong and doorways will not connect).
  4. Export the built `NavMesh` plus a `findRoomTarget(nameOrAlias: string): {x,z} | null` helper
     that looks up `rooms[].name`/`aliases` (case-insensitive) and returns the room's `door`
     snapped through `NavMeshQuery.findClosestPoint`.
- Tests: build the navmesh once, then assert `findRoomTarget("1425")` and
  `findRoomTarget("Classroom 1425")` both resolve to a point near the door coordinate in the JSON,
  and that `computePath` between the `entrance` point and at least 3 different rooms' doors
  succeeds (`success: true`, non-empty path) -- this is the real proof the doors connect to the
  corridor. If any path fails, that's a bug in Task 0.3's wall gaps, and it IS this task's job to
  report it precisely (which room, which wall segment) rather than silently work around it --
  escalate to the controller with NEEDS_CONTEXT if you hit this, don't hand-edit floor-14.json
  yourself.
Acceptance: all room doors path-reachable from the entrance; unit tests pass; report exactly
which rooms (if any) failed to path so the controller can fix floor-14.json.

**Task 1.2 — Crowd simulation loop in Colyseus** (depends on 1.1 and 0.1)
Files: `world/src/rooms/WorldRoom.ts` (extend, don't rewrite), `world/src/nav/crowd.ts`.
Requirements:
- `crowd.ts`: wraps `recast-navigation`'s `Crowd` -- `new Crowd(navMesh, {maxAgents: 128,
  maxAgentRadius: 0.5})`, `addAgent(pos, {radius, height, maxSpeed, separationWeight, ...})`,
  `requestMoveTarget`, and a `tick(dtSeconds)` that calls `crowd.update` and returns each agent's
  current `{id, x, z, heading}` (heading from velocity via `Math.atan2`).
- `WorldRoom.onCreate`: load the navmesh (Task 1.1's output), create the `Crowd`, call
  `this.setSimulationInterval(dt => this.update(dt))` (Colyseus default ~60Hz, dt is
  MILLISECONDS -- divide by 1000 and clamp to max 0.1s before passing to `crowd.tick`, this is
  the single most common bug per the research -- write a test for it). Add ONE test agent at the
  entrance point on room creation for now (no visitors/robots concept yet, that's Phase 4) so
  this task is independently testable.
- A method `moveAgentTo(agentId: string, roomNameOrCoords)` that resolves via
  `findRoomTarget` (Task 1.1) and calls the crowd agent's `requestMoveTarget`.
- Sync each Crowd agent's position into the `WorldState.agents` MapSchema entries every tick.
Test: an integration test that creates a room, calls `moveAgentTo` with a known room name,
advances simulated time (call `tick` directly rather than waiting on a real clock), and asserts
the agent's schema position converges to within some tolerance of that room's door.
Acceptance: test passes; report the measured `crowd.update` wall-clock time per tick with 1 agent
(a real number, not an assumption) so the controller can compare against the ~95-agent load
test in Task 1.3.

**Task 1.3 — Load test at ~95 agents** (depends on 1.2)
Files: `world/scripts/loadtest.ts` (or reuse `@colyseus/loadtest` if it fits cleanly).
Requirements: spin up 95 Crowd agents (matching the 50 robots + 45 visitors target) inside one
`WorldRoom` instance (no real network clients needed for this -- add them directly via the room's
internal API in a test/script, not through 95 real WebSocket connections, unless
`@colyseus/loadtest` makes that just as easy), give each a random room as a target, run the
simulation loop for a fixed number of ticks, and log wall-clock time per tick (min/avg/max) plus
whether any tick exceeded the 16.6ms budget (60fps).
Acceptance: report the actual measured numbers on this machine. This is explicitly the "prove it
on ~5 samples" check from the project's own standards -- do not report "should be fine," report
what you measured. If ticks are consistently over budget, say so plainly (BLOCKED or
DONE_WITH_CONCERNS) rather than softening it -- the controller needs the real number to decide
whether to lower `patchRate`, reduce agent count, or accept it for a browser demo where the
server doesn't need to hit 60Hz (only the client does).

### Phase 2 — IoT bridge and command schema

**Task 2.1 — Add `navigate` command type** (touches a SHARED file: `shared/guidemate_msgs`)
Files: `shared/guidemate_msgs/guidemate_msgs/messages.py`, `shared/guidemate_msgs/tests/test_messages.py`.
Requirements:
- Add `"navigate"` to the `Command.type` Literal (alongside existing `"emote"|"motion"|"stop"`).
- Add a `_NAVIGATE_NAMES` tuple, name is the room name or alias -- but names are open-ended (room
  numbers/labels), not a fixed short enum like emotes/motions, so validate differently: for
  `type == "navigate"`, `params` MUST contain either a `room` string key or both `x`/`z` numeric
  keys, and `name` should be a stable constant like `"goto"` (mirroring how `stop`'s name is
  always `"stop"`) -- keep this consistent with the existing validator style in
  `_check_name`, don't invent a different validation mechanism.
- This must NOT change behavior for `emote`/`motion`/`stop` -- add tests proving those three still
  validate exactly as before (copy/adapt existing tests), plus new tests for `navigate` (valid
  with `room`, valid with `x`/`z`, invalid with neither, invalid with a non-string `room`).
- IMPORTANT (git safety in a shared repo): before touching this file, run `git status`/`git diff`
  on it and stop with NEEDS_CONTEXT if there are already uncommitted foreign changes to it --
  this repo has multiple agents working the same tree in general, though you are working in an
  isolated worktree branch for this task, so this is a light sanity check, not the primary
  defense.
Acceptance: `pytest shared/guidemate_msgs/tests/test_messages.py` all green, including the new
`navigate` cases and the unchanged existing cases.

**Task 2.2 — Virtual fleet IoT identity** (independent of 2.1; touches AWS + scripts, needs the
controller's AWS access, not something a subagent can run standalone -- see note below)
Files: `scripts/create_virtual_fleet_identity.sh` (clone of the existing
`scripts/create_sim_identity.sh` pattern), a new IoT policy statement widening
`guidemate-sim-policy` (or a new `guidemate-fleet-policy`) to `guidemate/virtual/+/*` plus the
fleet thing's shadow topics.
Requirements: mirror `scripts/create_sim_identity.sh`'s idempotent style (skip-if-exists,
`tag-resource || true` for the untaggable-thing quirk documented in `access-ground-truth.md`).
Note for whoever picks this up: this task needs live `aws iot`/`aws sts` calls under the
`default` profile (the permanent `guidemate-agent-role` credentials) -- confirm those still work
(`aws sts get-caller-identity`) before running anything that creates resources, and this is an
AWS-account-mutating task, so the controller should review the exact IAM statement before it's
applied, not just the script text.
Acceptance: script is idempotent (safe to re-run), documents the new policy ARN/statement,
updates `docs/agent-poc/access-ground-truth.md` with the new resource (matching that file's
existing style for the `Turtlebot-Sim` entry).

**Task 2.3 — Node MQTT bridge in the world-server** (depends on 1.2 and 2.1; touches `world/`)
Files: `world/src/iot/bridge.ts`.
Requirements: subscribe to the virtual fleet's IoT Core topics (Task 2.2's output) using
`aws-iot-device-sdk-v2` (or `mqtt.js` if it proves simpler for a first pass -- decide and justify
in your report) with the world-server's IAM credentials (same account/region pattern as the
existing Python bridge -- read `src/guide_mate_bridge/guide_mate_bridge/bridge.py` and
`shared/guidemate_msgs/guidemate_msgs/messages.py` first to match the wire format exactly: same
`Command` JSON shape, same `cmd_id`/`ts` fields, ack back on the status topic in the same `Ack`
shape). On a `navigate` command for a given virtual robot id, call `WorldRoom`'s
`moveAgentTo` (Task 1.2). Publish an `Ack` (`received` then `done`/`failed`) matching the
existing schema.
Acceptance: an integration test (or a documented manual `aws iot-data publish` test against a dev
cert, matching the existing gated-test pattern in the Python bridge's tests) that a published
`navigate` command moves the corresponding agent in `WorldRoom` state, and an ack appears on the
status topic.

### Phase 3 — Three.js renderer (the look)

**Task 3.1 — Floor and wall geometry from JSON** (depends on 0.2, 0.3; independent of 1.x/2.x)
Files: `world-client/src/scene/Floor.tsx`, `world-client/src/scene/Walls.tsx`,
`world-client/src/scene/floorPlanTypes.ts` (mirror the JSON schema as TS types).
Requirements: load `world/data/floor-14.json` (copy or symlink it into `world-client/public/data/`
as part of this task, or set up a small build step -- decide and document which), render the
`walkableOutline` (minus `holes`) as a `THREE.ShapeGeometry` floor with the grey carpet material
(`MeshStandardMaterial`, `color: '#8a8a8a'`, `roughness: 0.95`, tiling normal map if a CC0 texture
was fetched by Task 0.4's follow-on, otherwise flat color is fine for this pass), and extrude each
`walls[]` segment to its `height` (glass ones as `MeshPhysicalMaterial` with
`transmission: 1, roughness: 0.1, thickness: 0.05, ior: 1.5, transparent: true`, non-glass as
plain `MeshStandardMaterial`). Render room name labels (drei `<Text>` or `<Html>`) at each room's
`center`.
Acceptance: browser preview screenshot showing the floor plan recognizably matching the room
layout (compare against `floor-14.json`'s room list), glass walls visually distinct from solid
walls, no z-fighting between floor and walls.

**Known forward-note from Task 0.2's review:** `floor-14.json`'s real footprint spans roughly
x:[0,36] z:[0,21], centroid ~(18,10) -- NOT centered on the origin like Task 0.2's placeholder
plane. You must either recenter the floor-plan geometry to straddle the origin, or recompute the
camera/`MapControls` target from the floor plan's actual bounds (e.g. its centroid). Don't leave
the view off-center by accident.

**Task 3.2 — Animated agents (robots + visitors)** (depends on 0.2, 0.4; independent of 3.1)
Files: `world-client/src/scene/Robot.tsx`, `world-client/src/scene/Visitor.tsx`,
`world-client/src/scene/AgentInstances.tsx`.
Requirements: robots use one drei `<Instances>` batch (rigid, no skinning -- one draw call for
all robot instances, transform-only per instance) loading `robot.glb`. Visitors use individual
`SkinnedMesh` clones via `SkeletonUtils.clone` (from `three/examples/jsm/utils/SkeletonUtils.js`)
of `visitor.glb`, each wrapped in drei's `useAnimations`, playing `Walking`/`Idle`-equivalent clips
(read the actual clip names from the loaded GLB -- don't hardcode names from the research report,
confirm what's really embedded in the fetched file) based on a `moving` boolean prop, with a
random per-instance time offset so they don't march in lockstep. Add drei `<Detailed>` LOD if
practical. This task does NOT yet connect to Colyseus (that's 3.3) -- test with a handful of
hardcoded agents at fixed positions, some `moving`, some not.
Acceptance: browser preview screenshot showing several robots (one draw call, verify via the
browser's performance/spector tooling or just trust the `<Instances>` API) and several animated
walking/idle visitors.

**Known forward-note from Task 0.2's review:** the scaffold's `directionalLight` has a default
shadow-camera frustum (~10x10 units centered on its target) that's too small for the real floor
(~36x21). Once agents cast shadows, widen the `shadow-camera` bounds (e.g.
`light.shadow.camera.left/right/top/bottom`) to cover the actual floor footprint, or shadows will
clip/vanish outside a small central area.

**Task 3.3 — Colyseus client wiring + route line** (depends on 3.1, 3.2, and 1.2/2.3 being live
for real data, but CAN be built/tested against Task 1.2's test room in the meantime)
Files: `world-client/src/net/useWorldRoom.ts`, `world-client/src/scene/RouteLine.tsx`,
`world-client/src/App.tsx` (wire it together).
Requirements: `@colyseus/sdk` client joins the `world` room, subscribes to `agents` MapSchema
changes, and drives each `Robot`/`Visitor` instance's position (interpolated between updates,
since the server patches at ~20Hz and the client renders at 60fps -- don't just snap to the
latest position, lerp toward it). Route line: for each robot currently navigating, render a
`meshline` ribbon along its known path (if the server doesn't expose the full path, a straight
line from current position to target is an acceptable first pass -- note this as a
DONE_WITH_CONCERNS item if you simplify it) laid flat just above the carpet, with an animated
`map.offset` for a flow effect, plus `@react-three/postprocessing`'s `<Bloom>`.
Acceptance: browser preview showing agents move smoothly (not choppy/snapping) when the server
moves Task 1.2's test agent, with a visible glowing route line during motion.

### Phase 4 — Moses control, simulated visitors, phone controller
(Not detailed task-by-task yet -- expand this section once Phases 0-3 are committed and
reviewed, since Phase 4 design may shift based on what's actually built. Rough shape from the
design spec: server-side simulated-visitor spawner in `WorldRoom`; a Moses agent tool that calls
the same command path as Task 2.3's bridge; reuse of the existing Moses chat frontend for the
phone controller with a QR join flow.)

### Phase 5 — Polish and demo hardening
(Not detailed yet -- expand after Phase 4. Rough shape from the design spec: deploy world-server
on the existing t3.large next to FastAPI, systemd unit, kiosk big-screen mode, admin kill-switch
wiring, physical-robot emote mirroring, rehearsal, risk register.)

## Parallelization notes for the controller
- Phase 0: Tasks 0.1, 0.2, 0.4 touch disjoint file sets -- dispatch together in parallel.
- Phase 1: 1.1 -> 1.2 -> 1.3 are sequential (each depends on the last), but 1.1 can run in
  parallel with anything in Phase 0 that's already done, since it only reads `floor-14.json`.
- Phase 2: 2.1 (Python schema) and 2.2 (AWS/scripts) touch disjoint files -- parallel-safe. 2.3
  depends on both.
- Phase 3: 3.1 and 3.2 touch disjoint files -- parallel-safe. 3.3 depends on both plus 1.2.
- Never parallelize two tasks that both touch `shared/guidemate_msgs/guidemate_msgs/messages.py`,
  `world/src/rooms/WorldRoom.ts`, or `world/data/floor-14.json` -- these are the shared-state
  files in this plan.
